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
import { Area, Automation } from "@/lib/ids";
import type {
  AutomationAction,
  AutomationRow,
  AutomationTrigger,
} from "@/lib/db/planetscale/schema";
import * as store from "@/lib/automations/store";
import { controllableDeviceScopeForUser } from "@/lib/dashboard/grants";
import { loadPointByUuid } from "@/lib/control/point-actions";

/**
 * How the caller reaches an area's automations.
 *
 *  - `manager`  — the area's owner, or an admin: every rule, every verb.
 *  - `delegate` — a `control` grantee (lib/dashboard/grants.ts): only the CHARGE LIMITS on cars they
 *    may command ({@link delegateMayManage}). A charge limit can only ever turn charging OFF and is
 *    spent with its session, so delegating it is delegating the stop button with a timer on it. An
 *    `exercise` rule STARTS an engine unattended, on a schedule, indefinitely — that stays the
 *    owner's, and `checkReferences` refuses it to anyone who does not own the generator anyway.
 */
export type AutomationAccess =
  | { kind: "manager" }
  | { kind: "delegate"; controllable: Set<number> };

/**
 * May a delegate see and manage this rule? A point-sourced charge limit whose action commands a car
 * in their control scope. Point-sourced only: that is the shape the car's own controls create, and
 * a derivation-sourced rule would fail the derivation READ check for someone who owns nothing —
 * a row they could see but never save is worse than one they do not see.
 */
export async function delegateMayManage(
  rule: { trigger: AutomationTrigger | null; action: AutomationAction | null },
  controllable: Set<number>,
): Promise<boolean> {
  if (
    rule.trigger?.kind !== "charge-session" ||
    rule.trigger.source?.kind !== "point" ||
    !rule.action?.pointId
  )
    return false;
  const point = await loadPointByUuid(rule.action.pointId);
  return point != null && controllable.has(point.deviceRid);
}

/**
 * The area gate for the automations collection: owner/admin as `manager`, else a `control` grantee
 * as `delegate`, else 403 — the same refusal `loadAreaForOwner` gives, which this replaces there.
 */
export async function loadAreaForAutomations(
  request: NextRequest,
  arId: string,
): Promise<
  | { userId: string; area: AreaAuthRow; access: AutomationAccess }
  | { error: NextResponse }
> {
  const auth = await requireAuth(request);
  if (auth instanceof NextResponse) return { error: auth };
  const uuid = Area.toUuidOrNull(arId);
  if (!uuid)
    return {
      error: NextResponse.json(
        { error: `Invalid area id: ${arId}` },
        { status: 400 },
      ),
    };
  const area = await loadAreaForAuth(uuid);
  if (!area)
    return {
      error: NextResponse.json({ error: "Area not found" }, { status: 404 }),
    };
  if (auth.isAdmin || area.ownerClerkUserId === auth.userId)
    return { userId: auth.userId, area, access: { kind: "manager" } };
  const controllable = await controllableDeviceScopeForUser(auth.userId);
  if (controllable.size > 0)
    return {
      userId: auth.userId,
      area,
      access: { kind: "delegate", controllable },
    };
  return {
    error: NextResponse.json(
      { error: "Write access required" },
      { status: 403 },
    ),
  };
}

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
  /** Admit a `control` grantee for a rule {@link delegateMayManage} allows (PATCH/DELETE only). */
  opts: { allowDelegate?: boolean } = {},
): Promise<
  | {
      row: AutomationRow;
      area: AreaAuthRow;
      userId: string;
      isAdmin: boolean;
      access: AutomationAccess;
    }
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
  if (!area) return { error: notFound() };
  // Same owner-or-admin predicate `loadAreaForOwner` applies — but collapsed to 404 (see above).
  if (auth.isAdmin || area.ownerClerkUserId === auth.userId)
    return {
      row,
      area,
      userId: auth.userId,
      isAdmin: auth.isAdmin,
      access: { kind: "manager" },
    };
  if (opts.allowDelegate) {
    const controllable = await controllableDeviceScopeForUser(auth.userId);
    if (controllable.size > 0 && (await delegateMayManage(row, controllable)))
      return {
        row,
        area,
        userId: auth.userId,
        isAdmin: auth.isAdmin,
        access: { kind: "delegate", controllable },
      };
  }
  return { error: notFound() };
}
