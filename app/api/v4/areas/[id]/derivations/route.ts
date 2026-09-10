import { NextRequest } from "next/server";
import { loadAreaForOwner } from "@/lib/areas/http";
import { getAreaMemberDeviceIds } from "@/lib/areas/members";
import { Device } from "@/lib/ids";
import { handleCreate, handleList } from "@/lib/derivations/v4-routes";

/**
 * SHIM. The derivations resource now lives at `/api/v4/derivations` — a derivation's site is DERIVED
 * from its source points, so there is no area to address it by. This tree stays because the operator
 * CLI still speaks it (PR 4 moves it) and because a URL that has been in a runbook should not 404
 * without warning.
 *
 * 🛑 **The area no longer authorizes anything.** `loadAreaForOwner` is still called, and deliberately
 * so: it preserves this address's existing 400/403/404 behaviour for an area the caller does not own,
 * which is the contract the CLI's error handling is written against. But the derivation-level
 * decision is made downstream against the derivation's own device set
 * (`lib/derivations/scope.ts`) — so this call is a compatibility check, not the grant it used to be.
 *
 * GET narrows the fleet-wide listing to the area's member devices. POST ignores the area entirely,
 * except for one back-compat leg: an `hws-model` body with no `device` takes the area's own handle,
 * which is what "create the HWS model on this area-of-one" used to mean.
 */
export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id } = await params;
  const authed = await loadAreaForOwner(request, id);
  if ("error" in authed) return authed.error;
  const members = await getAreaMemberDeviceIds(authed.area.id);
  return handleList(request, {
    deviceUuids: members.map((m) => Device.toUuid(m)),
  });
}

export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id } = await params;
  const authed = await loadAreaForOwner(request, id);
  if ("error" in authed) return authed.error;
  return handleCreate(request, {
    hwsFallbackHandle: authed.area.legacySystemId,
  });
}
