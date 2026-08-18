/**
 * Bounded concurrency + deadlines for the minutely poll loop.
 *
 * The loop used to be a plain sequential `for…of` inside a 60 s `maxDuration`, which made the
 * function's time budget a SHARED resource: whatever a slow vendor spent, everyone after it went
 * without. Measured over 24 h on prod — Sigenergy's HTTP 502s each burned exactly 32 s in a retry
 * ladder, one tick reached 72.9 s, and the consequences were both failure modes you would predict:
 * 38 minutes where a device was polled twice (a tick overran and the next one started on top of it)
 * and 9 ticks that ran but never reached the 1-minute Selectronic device at all.
 *
 * Concurrency here buys ISOLATION, not throughput — median tick load is only ~2.2 s. The reason a
 * worker pool is needed rather than deadlines alone is that deadlines are necessarily
 * heterogeneous: Tesla's wake loop legitimately wants ~30 s while Sigenergy's ladder should be cut
 * at 15 s, so a sequential worst case sums past 60 s however they are tuned. With `n` workers the
 * worst case is `ceil(devices/n) × deadline`.
 */

/** Max devices polled at once. Kept modest: each poll holds 1-2 pooled PG connections, and
 *  `PLANETSCALE_POOL_MAX` defaults to 10 per warm instance. */
export const POLL_CONCURRENCY = Number(process.env.POLL_CONCURRENCY ?? 4);

export class DeadlineExceededError extends Error {
  constructor(readonly ms: number) {
    super(`exceeded its ${(ms / 1000).toFixed(0)}s poll deadline`);
    this.name = "DeadlineExceededError";
  }
}

/**
 * Reject if `work` hasn't settled within `ms`.
 *
 * ⚠️ This frees the WORKER, not the socket: the abandoned promise keeps running until its own I/O
 * settles. That is the point — the other devices stop waiting on it — but a vendor client that can
 * hang indefinitely should also carry its own `AbortSignal.timeout` so the request itself dies.
 */
export function withDeadline<T>(work: Promise<T>, ms: number): Promise<T> {
  if (!(ms > 0)) return work;
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new DeadlineExceededError(ms)), ms);
    work.then(
      (v) => {
        clearTimeout(timer);
        resolve(v);
      },
      (e) => {
        clearTimeout(timer);
        reject(e);
      },
    );
  });
}

/**
 * Run `fn` over `items` with at most `limit` in flight, returning results in INPUT order.
 *
 * Order matters even though the work is concurrent: it keeps the response and the logs readable
 * against the dispatch order the caller chose (tightest slot first), so a truncated tick is
 * legible rather than a shuffled subset.
 */
export async function mapWithConcurrency<T, R>(
  items: readonly T[],
  limit: number,
  fn: (item: T, index: number) => Promise<R>,
): Promise<R[]> {
  const results = new Array<R>(items.length);
  let next = 0;

  const worker = async (): Promise<void> => {
    for (;;) {
      const i = next++;
      if (i >= items.length) return;
      results[i] = await fn(items[i], i);
    }
  };

  await Promise.all(
    Array.from({ length: Math.max(1, Math.min(limit, items.length)) }, worker),
  );
  return results;
}
