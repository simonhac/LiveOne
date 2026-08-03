import { NextRequest, NextResponse } from "next/server";
import { requireDeviceAccess } from "@/lib/api-auth";
import { loadAreaForOwner } from "@/lib/areas/http";
import {
  loadPointByStemMetric,
  loadPointByUuid,
} from "@/lib/control/point-actions";
import type { AutomationMode } from "@/lib/db/planetscale/schema";
import * as store from "@/lib/automations/store";
import { actionFromWire, automationWire, triggerFromWire } from "@/lib/automations/wire";

/**
 * Charge-limit automations — "stop charging after x minutes and/or y kWh".
 *
 *   GET  /api/v4/automations?area=ar_…  → 200 { automations: [...] }
 *   POST /api/v4/automations            → 201 { automation }
 *
 * TypeIDs on the wire, raw uuids inside. Area-scoped and owner-or-admin via `loadAreaForOwner`,
 * exactly like the derivations resource. Deliberately in NEITHER `publicRoutes` nor
 * `shareableRoutes` (`lib/route-matchers.ts`): a share token must never reach a mutation, and
 * every verb here is a mutation or an owner read.
 *
 * 🛑 An automation is a DEFERRED action call — at fire time the evaluator dispatches with the
 * DEVICE OWNER's credentials and no session user at all. So creation must clear the same firewalls
 * the synchronous action route does, or owning any area would let a caller aim a `turn_off` at
 * someone else's car. Hence `requireDeviceAccess(..., {requireWrite:true})` on the action point
 * (and a read check on the source point) BELOW, in addition to the area check.
 */

const MODES: AutomationMode[] = ["once", "standing"];

function unprocessable(error: string): NextResponse {
  return NextResponse.json({ error }, { status: 422 });
}

export async function GET(request: NextRequest) {
  const areaParam = new URL(request.url).searchParams.get("area");
  // Required: a cross-area listing is a later PR's call to ask for, and defaulting to "everything
  // readable" would quietly widen the surface.
  if (!areaParam) return unprocessable("area (ar_…) is required");

  const authed = await loadAreaForOwner(request, areaParam);
  if ("error" in authed) return authed.error;

  const rows = await store.listForArea(authed.area.id);
  return NextResponse.json({ automations: rows.map(automationWire) });
}

export async function POST(request: NextRequest) {
  const body = (await request.json().catch(() => null)) as Record<
    string,
    unknown
  > | null;
  if (!body) return unprocessable("Body must be JSON");

  const areaId = typeof body.areaId === "string" ? body.areaId : null;
  if (!areaId) return unprocessable("areaId (ar_…) is required");
  const authed = await loadAreaForOwner(request, areaId);
  if ("error" in authed) return authed.error;
  const areaUuid = authed.area.id;

  const mode = body.mode;
  if (typeof mode !== "string" || !MODES.includes(mode as AutomationMode))
    return unprocessable(`mode must be one of: ${MODES.join(", ")}`);

  const trigger = triggerFromWire(body.trigger);
  if (!trigger.ok) return unprocessable(trigger.error);
  const action = actionFromWire(body.action);
  if (!action.ok) return unprocessable(action.error);

  const checked = await checkReferences(
    request,
    areaUuid,
    trigger.value,
    action.value,
  );
  if (checked) return checked;

  if (body.enabled !== undefined && typeof body.enabled !== "boolean")
    return unprocessable("enabled must be a boolean");
  const name =
    typeof body.name === "string" && body.name.trim() !== ""
      ? body.name
      : "Charge limit";

  const row = await store.create({
    areaId: areaUuid,
    name,
    mode: mode as AutomationMode,
    trigger: trigger.value,
    action: action.value,
    enabled: body.enabled as boolean | undefined,
  });
  return NextResponse.json({ automation: automationWire(row) }, { status: 201 });
}

/**
 * Referential + authorization checks for a trigger/action pair. Returns a response to send, or
 * null when everything clears. Shared with the PATCH route, which re-runs the whole set whenever
 * either object is replaced.
 */
export async function checkReferences(
  request: NextRequest,
  areaUuid: string,
  trigger: { source: { kind: "derivation"; derivationId: string } | { kind: "point"; pointId: string }; afterKwh?: number },
  action: { pointId: string },
): Promise<NextResponse | null> {
  if (trigger.source.kind === "derivation") {
    // Same-area scoping is what makes the area-owner check above cover the trigger — without it,
    // owning any area would let a caller follow any derivation by id.
    const ok = await store.derivationBelongsToArea(
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
    if (!stem)
      return unprocessable("trigger source point has no logical path");
    const sibling = await loadPointByStemMetric(loaded.deviceRid, stem, "active");
    if (!sibling)
      return unprocessable(
        `trigger source point has no ${stem}/active sibling to signal the charge session`,
      );
    // The unit trap (a detector's `upperW` in watts against a kW point) must not get a second
    // life here: a kWh threshold against a non-kWh counter is off by whatever factor.
    if (trigger.afterKwh !== undefined && loaded.point.unit !== "kWh")
      return unprocessable(
        `afterKwh requires a kWh trigger point (this one is in '${loaded.point.unit ?? "?"}')`,
      );
  }

  const actionPoint = await loadPointByUuid(action.pointId);
  if (!actionPoint) return unprocessable("action point not found");
  // 🛑 WRITE access, not read. See the header.
  const write = await requireDeviceAccess(request, actionPoint.deviceRid, {
    requireWrite: true,
  });
  if (write instanceof NextResponse) return write;
  // `points.control` is deliberately NOT checked here: it self-heals on the next poll after a
  // deploy, and blocking creation during that window would be a confusing dead end. Dispatch-time
  // validation owns it.
  return null;
}
