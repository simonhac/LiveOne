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
import { loadDerivation } from "@/lib/derivations/scope";
import { Derivation } from "@/lib/ids";

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
  // 🛑 The action vocabulary is gated on the TRIGGER kind, not just checked in isolation.
  // `set_value` on this table means "start something for N units", and the only rule that has been
  // designed to decide that safely — never while a run is in progress, never twice for one slot —
  // is `exercise`. The charge-session path calls `fire()`, which hardcodes `turn_off`, so letting a
  // `set_value` be stored against one would either be ignored or, worse, later honoured by a
  // refactor that "fixed" the inconsistency in the wrong direction.
  if (action.action === "set_value" && trigger.kind !== "exercise")
    return unprocessable(
      "set_value actions are only valid with an exercise trigger",
    );
  if (action.action !== "set_value" && trigger.kind === "exercise")
    return unprocessable("an exercise trigger requires a set_value action");

  if (trigger.source.kind === "derivation") {
    // 🛑 READABILITY FIRST, and the order is the whole point. The caller must be able to READ this
    // derivation, judged against its own device set — scoping alone used to carry that job too ("it
    // is in your area" implied "you may see it", because the area's owner check preceded it), and it
    // no longer does: a derivation belongs to an area by MEMBERSHIP now, and an area can hold a
    // device you do not own. This is the same check the derivations surface makes, through the same
    // loader, so the two cannot drift.
    //
    // Doing it SECOND would rebuild the existence oracle the 404 exists to prevent: an unknown
    // derivation would fail the membership check with a 422 while an existing-but-unreadable one
    // reached this and answered 404, and the difference between those two replies is precisely the
    // fact the collapse is there to withhold. First, both are 404.
    const readable = await loadDerivation(
      request,
      Derivation.encode(trigger.source.derivationId),
      "read",
    );
    if ("error" in readable) return readable.error;
    // Same-area scoping, still: an automation IS scoped to a site (`automations.area_id` stays NOT
    // NULL), so a trigger naming a derivation you CAN see but that lives elsewhere is a body error.
    const ok = await derivationBelongsToArea(
      trigger.source.derivationId,
      areaUuid,
    );
    if (!ok)
      return unprocessable("trigger derivation must belong to this area");
  } else {
    const loaded = await loadPointByUuid(trigger.source.pointId);
    if (!loaded) return unprocessable("trigger source point not found");
    const access = await requireDeviceAccess(request, loaded.deviceRid);
    if (access instanceof NextResponse) return access;
    const stem = loaded.point.logicalPath;
    if (!stem) return unprocessable("trigger source point has no logical path");
    const sibling = await loadPointByStemMetric(
      loaded.deviceRid,
      stem,
      "active",
    );
    if (!sibling)
      return unprocessable(
        `trigger source point has no ${stem}/active sibling to signal the charge session`,
      );
    // The unit trap (a detector's watts threshold read against a kW point) must not get a second
    // life here: a kWh limit against a non-kWh counter is wrong by whatever the factor happens
    // to be, silently.
    if (
      trigger.kind === "charge-session" &&
      trigger.afterKwh !== undefined &&
      loaded.point.unit !== "kWh"
    )
      return unprocessable(
        `afterKwh requires a kWh trigger point (this one is in '${loaded.point.unit ?? "?"}')`,
      );
  }

  if (trigger.kind === "exercise") {
    const load = await loadPointByUuid(trigger.unless.loadPointId);
    if (!load) return unprocessable("trigger load point not found");
    const access = await requireDeviceAccess(request, load.deviceRid);
    if (access instanceof NextResponse) return access;
    // The unit trap again, and here it is worse than a wrong number: `minLoadKw` is compared
    // against watts converted by `importKw`. Against a point already in kW, a 1.5 kW floor would
    // become a 1500 kW floor — never met, so the rule would exercise the engine every single week
    // regardless of how much work it had already done, and look like it was working.
    if (load.point.unit !== "W")
      return unprocessable(
        `the load point must be in W (this one is in '${load.point.unit ?? "?"}')`,
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
