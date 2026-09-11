/**
 * Timeout primitives shared by the collector.
 *
 * The hub's whole failure model is "a promise that never settles", not "a promise that rejects":
 * a Modbus read on a silently-dead socket, a `socket.end()` whose FIN is never acked, a write to a
 * wedged volume. None of those throw — they simply never come back, and an unbounded `await` on
 * one hangs the poll loop for the life of the process. So anything that touches the device, the
 * network or the disk gets bounded here rather than trusting the collaborator to time itself out.
 *
 * These used to be three near-identical private copies (core/run.ts, clients/dse-client.ts, and a
 * hand-rolled race inside sources/musher.ts's withLock). Two of them differed in exactly the way
 * that matters — see `withTimeout` below.
 */

/**
 * Reject with `message` if `p` hasn't settled within `ms`.
 *
 * The late settlement of `p` is deliberately swallowed: once we've stopped waiting, a rejection
 * arriving afterwards has no handler and would otherwise surface as an unhandled rejection (which
 * under Next's installed handlers is logged and ignored — noisy, and easy to misread as the cause
 * rather than the echo).
 */
export function withTimeout<T>(
  p: Promise<T>,
  ms: number,
  message: string,
): Promise<T> {
  let timer: ReturnType<typeof setTimeout>;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(message)), ms);
  });
  p.catch(() => {}); // don't let a post-timeout rejection become unhandled
  return Promise.race([p, timeout]).finally(() => clearTimeout(timer));
}

/**
 * Wait up to `ms` for `p` to settle. Resolves `true` if it did, `false` if it timed out or threw.
 *
 * The honest signature for "close this socket, and I don't care how it goes" — every caller of
 * DseClient.close() already swallows, so a boolean says what they actually want to know (did it
 * finish, so can I skip the fallback?) without making them write another try/catch.
 */
export async function settledWithin(
  p: Promise<unknown>,
  ms: number,
): Promise<boolean> {
  try {
    await withTimeout(p, ms, "timed out");
    return true;
  } catch {
    return false;
  }
}

/**
 * Resolve after `ms`.
 *
 * `unref` for timers that exist only as a safety net (e.g. a backstop that lets a promise chain
 * advance): they must never be the reason the process stays alive. Matches the `unref?.()` the
 * hub already uses for its maintenance and stop-retry timers.
 */
export function delay(
  ms: number,
  opts: { unref?: boolean } = {},
): Promise<void> {
  return new Promise((resolve) => {
    const t = setTimeout(resolve, ms);
    if (opts.unref) t.unref?.();
  });
}
