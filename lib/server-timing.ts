/**
 * Server-Timing instrumentation for the dashboard's hot API routes — see
 * docs/performance/dashboard-fetch-waterfall.md ("Server-side phase decomposition").
 *
 * Emits the standard `Server-Timing` response header, which browsers surface on
 * `performance.getEntriesByType('resource')[].serverTiming` — the same API the fetch-waterfall
 * benchmark harness reads, so per-phase server timings ride along with every benchmark run at zero
 * extra tooling. Durations only (no values, no PII); always on.
 *
 * Spans are measured with `time()`/`timeSync()` wrappers, each recording its OWN elapsed time —
 * not deltas since a previous mark — so concurrently-awaited spans (e.g. the `Promise.all` reads in
 * /api/data) time correctly; overlapping spans simply overlap, and their sum may exceed `total`.
 * Duplicate span names are legal (Server-Timing is a list-valued header) and show repeated work.
 *
 * The middleware self-reports its elapsed (Clerk `auth.protect()` etc.) via the
 * `x-middleware-dur` REQUEST header (see middleware.ts); `makeTimer(request)` reproduces it as the
 * leading `mw` entry so the client sees edge + handler phases in one merged header. The remaining
 * gap — client-observed duration minus `mw` minus `total` — is function invocation + network.
 */

export interface ServerTimer {
  /** Time an awaited async phase; the span records even if `fn` throws. */
  time<T>(name: string, fn: () => Promise<T>): Promise<T>;
  /** Time a synchronous phase (e.g. JSON serialization). */
  timeSync<T>(name: string, fn: () => T): T;
  /** The `Server-Timing` header value: every span plus `total` (elapsed since construction). */
  header(): string;
}

/** Middleware → route-handler pass-through header. Set by middleware.ts, read by makeTimer. */
export const MIDDLEWARE_DUR_HEADER = "x-middleware-dur";

/**
 * Forward a REQUEST header to the origin from middleware, mutating an already-built middleware
 * response — Next.js's `x-middleware-override-headers` + `x-middleware-request-*` mechanism (the
 * same one Clerk's own `setRequestHeadersOnNextResponse` uses, so the two compose). Needed because
 * middleware.ts times the WHOLE `clerkMiddleware` invocation (Clerk's `authenticateRequest` runs
 * BEFORE the user callback, so timing inside the callback would miss nearly all of it) — by the
 * time the duration is known, the response object already exists and `NextResponse.next({request})`
 * is no longer an option.
 *
 * Semantics (mirrors Clerk): the override header lists the COMPLETE resulting request-header set,
 * so when absent it must first be seeded with every existing request header — seeding it with only
 * the new name would strip cookies/auth from the forwarded request. `set` (not append) on the value
 * also scrubs any spoofed inbound copy of the header.
 */
export function forwardRequestHeader(
  res: Response,
  req: Request,
  name: string,
  value: string,
): void {
  const OVERRIDE = "x-middleware-override-headers";
  const PREFIX = "x-middleware-request-";
  if (!res.headers.get(OVERRIDE)) {
    res.headers.set(OVERRIDE, [...req.headers.keys()].join(","));
    req.headers.forEach((val, key) => res.headers.set(`${PREFIX}${key}`, val));
  }
  res.headers.set(OVERRIDE, `${res.headers.get(OVERRIDE)},${name}`);
  res.headers.set(`${PREFIX}${name}`, value);
}

export function makeTimer(request?: Request): ServerTimer {
  const t0 = performance.now();
  const spans: [string, number][] = [];

  const mw = request?.headers.get(MIDDLEWARE_DUR_HEADER);
  if (mw != null && Number.isFinite(Number(mw))) {
    spans.push(["mw", Number(mw)]);
  }

  return {
    async time<T>(name: string, fn: () => Promise<T>): Promise<T> {
      const start = performance.now();
      try {
        return await fn();
      } finally {
        spans.push([name, performance.now() - start]);
      }
    },
    timeSync<T>(name: string, fn: () => T): T {
      const start = performance.now();
      try {
        return fn();
      } finally {
        spans.push([name, performance.now() - start]);
      }
    },
    header(): string {
      return [...spans, ["total", performance.now() - t0] as [string, number]]
        .map(([name, dur]) => `${name};dur=${dur.toFixed(1)}`)
        .join(", ");
    },
  };
}
