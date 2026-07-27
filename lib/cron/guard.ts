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

/** Scheduled cron work runs only when explicitly enabled. */
export function cronsEnabled(): boolean {
  return process.env.CRONS_ENABLED === "true";
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
