/**
 * Referential + authorization checks for an automation's trigger/action pair.
 *
 * 🛑 An automation is a DEFERRED action call: at fire time the evaluator dispatches with the DEVICE
 * OWNER's credentials and no session user at all. So whoever CREATES (or re-points) one must clear
 * the same firewalls the synchronous action route does — otherwise owning (or administering) any
 * area would let a caller aim a `turn_off` at someone else's car and have us execute it on their
 * behalf. That firewall is OWNERSHIP of the action point's device (`requireOwner`), which is
 * strictly narrower than the area gate above it: `loadAreaForOwner` admits admins, and the control
 * plane does not.
 *
 * Lives here rather than in the route module because both `POST /api/v4/automations` and
 * `PATCH /api/v4/automations/[id]` need it, and a Next.js `route.ts` may only export HTTP verbs and
 * route segment config.
 */
import { NextRequest, NextResponse } from "next/server";
import { requireDeviceAccess } from "@/lib/api-auth";
import {
  loadPointByStemMetric,
  loadPointByUuid,
} from "@/lib/control/point-actions";
import type {
  AutomationAction,
  AutomationTrigger,
} from "@/lib/db/planetscale/schema";
import { derivationBelongsToArea } from "./store";

function unprocessable(error: string): NextResponse {
  return NextResponse.json({ error }, { status: 422 });
}

/** Returns a response to send, or null when everything clears. */
export async function checkReferences(
  request: NextRequest,
  areaUuid: string,
  trigger: AutomationTrigger,
  action: AutomationAction,
): Promise<NextResponse | null> {
  if (trigger.source.kind === "derivation") {
    // Same-area scoping is what makes the area-owner check cover the trigger — without it, owning
    // any area would let a caller follow any derivation by id.
    const ok = await derivationBelongsToArea(
      trigger.source.derivationId,
      areaUuid,
    );
    if (!ok) return unprocessable("trigger derivation must belong to this area");
  } else {
    const loaded = await loadPointByUuid(trigger.source.pointId);
    if (!loaded) return unprocessable("trigger source point not found");
    const access = await requireDeviceAccess(request, loaded.deviceRid);
    if (access instanceof NextResponse) return access;
    const stem = loaded.point.logicalPath;
    if (!stem) return unprocessable("trigger source point has no logical path");
    const sibling = await loadPointByStemMetric(loaded.deviceRid, stem, "active");
    if (!sibling)
      return unprocessable(
        `trigger source point has no ${stem}/active sibling to signal the charge session`,
      );
    // The unit trap (a detector's watts threshold read against a kW point) must not get a second
    // life here: a kWh limit against a non-kWh counter is wrong by whatever the factor happens
    // to be, silently.
    if (trigger.afterKwh !== undefined && loaded.point.unit !== "kWh")
      return unprocessable(
        `afterKwh requires a kWh trigger point (this one is in '${loaded.point.unit ?? "?"}')`,
      );
  }

  const actionPoint = await loadPointByUuid(action.pointId);
  if (!actionPoint) return unprocessable("action point not found");
  // 🛑 OWNERSHIP, not write access. See the header: this is a deferred command, so it must clear
  // the CONTROL gate the synchronous action route clears, not the config-write gate. `requireWrite`
  // (owner OR admin) would let a non-owner admin park a `turn_off` on someone else's car and have
  // the cron dispatch it on that owner's vendor credentials — the exact thing
  // `lib/control/ownership.ts` exists to refuse. `requireOwner` is strictly narrower (an owner
  // always has write), and it refuses the `null === null` match on an ownerless device too.
  const owned = await requireDeviceAccess(request, actionPoint.deviceRid, {
    requireOwner: true,
  });
  if (owned instanceof NextResponse) return owned;
  // `points.control` is deliberately NOT checked here: it self-heals on the next poll after a
  // deploy, and blocking creation during that window would be a confusing dead end. Dispatch-time
  // validation owns it.
  return null;
}
