/**
 * Shared HTTP helpers for the `/api/v4/automations` routes.
 *
 * Extracted from `app/api/v4/automations/[id]/route.ts` when `POST …/{id}/move` arrived and needed
 * the same loader. A Next.js `route.ts` should export handlers and route config and nothing else, so
 * a second route file cannot import from it — the same reason `lib/derivations/v4-routes.ts` exists.
 */
import { NextRequest, NextResponse } from "next/server";
import { requireAuth } from "@/lib/api-auth";
import { loadAreaForAuth, type AreaAuthRow } from "@/lib/areas/http";
import { Automation } from "@/lib/ids";
import type { AutomationRow } from "@/lib/db/planetscale/schema";
import * as store from "@/lib/automations/store";

export function unprocessable(error: string): NextResponse {
  return NextResponse.json({ error }, { status: 422 });
}

export function notFound(): NextResponse {
  return NextResponse.json({ error: "Automation not found" }, { status: 404 });
}

/**
 * Authenticate + resolve + authorize. Returns the row, or the response to send.
 *
 * 🛑 "Not yours" is collapsed to 404, deliberately, and that is not merely tidiness: an automation
 * id is guessable-adjacent, and distinguishing "no such rule" from "someone else's rule" would
 * confirm the existence of another account's control-plane configuration.
 */
export async function loadOwnedAutomation(
  request: NextRequest,
  id: string,
): Promise<
  | { row: AutomationRow; area: AreaAuthRow; userId: string; isAdmin: boolean }
  | { error: NextResponse }
> {
  const auth = await requireAuth(request);
  if (auth instanceof NextResponse) return { error: auth };

  const uuid = Automation.toUuidOrNull(id);
  if (!uuid)
    return {
      error: NextResponse.json(
        { error: `Invalid automation id: ${id}` },
        { status: 400 },
      ),
    };

  const row = await store.getById(uuid);
  if (!row) return { error: notFound() };

  const area = await loadAreaForAuth(row.areaId);
  // Same owner-or-admin predicate `loadAreaForOwner` applies — but collapsed to 404 (see above).
  if (!area || !(auth.isAdmin || area.ownerClerkUserId === auth.userId))
    return { error: notFound() };

  return { row, area, userId: auth.userId, isAdmin: auth.isAdmin };
}
