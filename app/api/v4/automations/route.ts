import { NextRequest, NextResponse } from "next/server";
import { loadAreaForOwner } from "@/lib/areas/http";
import type { AutomationMode } from "@/lib/db/planetscale/schema";
import { checkReferences } from "@/lib/automations/references";
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
 * someone else's car. The area gate above is owner-OR-ADMIN and is therefore NOT enough on its own;
 * `checkReferences` additionally requires the caller to OWN the action point's device
 * (`requireDeviceAccess(..., {requireOwner:true})`), plus a read check on the source point.
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

  if (body.enabled !== undefined && typeof body.enabled !== "boolean")
    return unprocessable("enabled must be a boolean");

  // Every shape check is above this line: a malformed body must not pay for the point and device
  // lookups `checkReferences` performs before earning its 422.
  const checked = await checkReferences(
    request,
    areaUuid,
    trigger.value,
    action.value,
  );
  if (checked) return checked;

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
