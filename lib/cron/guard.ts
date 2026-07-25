/**
 * Cron kill-switch.
 *
 * Scheduled cron work runs ONLY when `CRONS_ENABLED=true`, in every environment
 * (including production). Unset/false ⇒ off. This keeps local dev and Vercel
 * preview — which now share the `liveone-dev` database — from double-polling
 * vendors or polluting the shared mirror.
 *
 * NOTE: prod must set `CRONS_ENABLED=true` or all scheduled work silently no-ops.
 *
 * Vercel only fires `vercel.json` crons on the PRODUCTION deployment — never on
 * preview. So day-to-day this flag mainly protects the shared dev DB from local
 * manual triggers, and gives an instant prod kill-switch.
 */

import { NextRequest } from "next/server";
import type { AuthContext } from "@/lib/api-auth";
import { kv, kvKey } from "@/lib/kv";

/** Scheduled cron work runs only when explicitly enabled. */
export function cronsEnabled(): boolean {
  return process.env.CRONS_ENABLED === "true";
}

/**
 * KV flag that quiesces cron writers for the config-v4 cutover window.
 *
 * Set (`prod:cutover:paused`) at the start of the window, cleared at resume. This is deliberately
 * SEPARATE from `CRONS_ENABLED`: the cutover must keep the pollers running (collection is buffered
 * through `observations_outbox`, never interrupted) while stopping everything that WRITES the hot
 * tables or drains the outbox. Flipping `CRONS_ENABLED=false` would stop the pollers too.
 */
export const CUTOVER_PAUSED_KEY = "cutover:paused";

/**
 * Is the cutover pause flag set?
 *
 * **Fails CLOSED**: if the KV read throws, we report paused. During an irreversible window a cron that
 * wrongly runs (writing to a half-transformed database) is far worse than a cron that wrongly skips —
 * a skipped run is picked up by the next tick.
 *
 * NB an UNCONFIGURED KV is not an error: `lib/kv.ts` proxies every method to `() => Promise.resolve(null)`
 * without throwing, so this returns false (not paused). That only happens where KV is absent — local dev,
 * where `CRONS_ENABLED` is already unset — never in production, which always has KV configured.
 */
export async function cutoverPaused(): Promise<boolean> {
  try {
    const value = await kv.get(kvKey(CUTOVER_PAUSED_KEY));
    // Treat any set, non-falsey value as paused ("1", 1, true, "yes", …).
    return !(
      value === null ||
      value === undefined ||
      value === 0 ||
      value === "0" ||
      value === false
    );
  } catch (error) {
    console.error(
      `[CutoverGate] KV read failed for ${kvKey(CUTOVER_PAUSED_KEY)} — failing CLOSED (treating as paused)`,
      error,
    );
    return true;
  }
}

/** How long a successful {@link cutoverPausedForIngest} read is reused. */
const INGEST_GATE_TTL_MS = 10_000;
/** How long a cached NEGATIVE survives a KV outage before the gate reverts to failing closed. */
const INGEST_GATE_GRACE_MS = 60_000;

let ingestGate: { paused: boolean; atMs: number } | null = null;

/** Test seam — the receiver gate memoizes across invocations within a warm serverless instance. */
export function __resetCutoverIngestGateForTests(): void {
  ingestGate = null;
}

/**
 * The cutover gate as the OBSERVATIONS RECEIVER needs it — same flag, different failure economics.
 *
 * The receiver is the single writer of the serving store and runs on the ingest hot path, so the plain
 * {@link cutoverPaused} is the wrong shape here in two ways:
 *
 *  - **Cost.** An uncached Upstash round-trip on every message, forever, to guard a once-ever 30-minute
 *    window. A short TTL collapses that to at most one read per {@link INGEST_GATE_TTL_MS}, and the flag
 *    is set minutes before stage 4 begins — the quiescence gate holds for far longer than the TTL — so
 *    the staleness is free.
 *  - **Availability.** Failing closed is right for a cron (a skipped tick is picked up by the next one)
 *    and wrong as an unconditional rule here: a KV incident would 500 every observation batch, halting
 *    ingest and burning QStash's retry budget toward the DLQ, months away from any cutover. So a KV
 *    error falls back to the last SUCCESSFUL read while it is fresh ({@link INGEST_GATE_GRACE_MS}); only
 *    once that is stale — or if we have never had a successful read — does it fail closed. Inside a real
 *    window the flag has been set and observed, so the fallback says "paused" and the safety holds; in a
 *    steady-state blip it says "not paused" and ingest continues.
 */
export async function cutoverPausedForIngest(): Promise<boolean> {
  const now = Date.now();
  if (ingestGate && now - ingestGate.atMs < INGEST_GATE_TTL_MS)
    return ingestGate.paused;
  try {
    const value = await kv.get(kvKey(CUTOVER_PAUSED_KEY));
    const paused = !(
      value === null ||
      value === undefined ||
      value === 0 ||
      value === "0" ||
      value === false
    );
    ingestGate = { paused, atMs: now };
    return paused;
  } catch (error) {
    if (ingestGate && now - ingestGate.atMs < INGEST_GATE_GRACE_MS) {
      console.error(
        `[CutoverGate] KV read failed for ${kvKey(CUTOVER_PAUSED_KEY)} — reusing the last good value (paused=${ingestGate.paused})`,
        error,
      );
      return ingestGate.paused;
    }
    console.error(
      `[CutoverGate] KV read failed for ${kvKey(CUTOVER_PAUSED_KEY)} with no fresh cached value — failing CLOSED`,
      error,
    );
    return true;
  }
}

/**
 * Decide whether a cron should skip because the cutover window is in progress.
 *
 * Same override semantics as {@link cronSkipReason}: a Clerk admin session, the dev `x-claude` header,
 * or `?force=true` proceed anyway (the operator's escape hatch during the window). A `CRON_SECRET`
 * bearer call is the scheduled run we mean to suppress, so it is NOT an override.
 *
 * @returns `null` to proceed, or a `{ skipped, reason }` payload the caller returns as a 200 no-op.
 */
export async function cutoverSkipReason(
  request: NextRequest,
  ctx: AuthContext,
): Promise<{ skipped: true; reason: string } | null> {
  if (!(await cutoverPaused())) return null;

  const forced = request.nextUrl.searchParams.get("force") === "true";
  if (ctx.isAdmin || ctx.isClaudeDev || forced) return null;

  return {
    skipped: true,
    reason: `config-v4 cutover in progress (${kvKey(CUTOVER_PAUSED_KEY)} set)`,
  };
}

/**
 * Decide whether a cron request should do real work.
 *
 * @returns `null` to proceed, or a `{ skipped, reason }` payload the caller
 *   returns as a 200 no-op (a success stops QStash/Vercel retry storms).
 *
 * Human/admin overrides always bypass the kill-switch: a Clerk admin session
 * (`isAdmin`), the dev `x-claude` header (`isClaudeDev`), or an explicit
 * `?force=true`. A `CRON_SECRET` bearer call (`isCron`) is exactly the scheduled
 * run we suppress, so it is NOT treated as an override.
 */
export function cronSkipReason(
  request: NextRequest,
  ctx: AuthContext,
): { skipped: true; reason: string } | null {
  if (cronsEnabled()) return null;

  const forced = request.nextUrl.searchParams.get("force") === "true";
  if (ctx.isAdmin || ctx.isClaudeDev || forced) return null;

  return {
    skipped: true,
    reason: `crons disabled (CRONS_ENABLED=${process.env.CRONS_ENABLED ?? "unset"})`,
  };
}
