import { NextRequest, NextResponse } from "next/server";
import { loadAreaForOwner, resolveMemberDeviceRefs } from "@/lib/areas/http";
import {
  replaceMembers,
  refreshAreaServing,
  AreaValidationError,
} from "@/lib/areas/create";
import { loadAreaMembers } from "@/lib/areas/v4-load";
import { areaMembersWire } from "@/lib/areas/v4-shapes";
import { DeviceConfigRegistry } from "@/lib/registry/device-config";

/**
 * An Area's member devices, as ONE declarative collection (§9.2).
 *   PUT { members: [dv_…] } → 200 { members: [{ id: dv_…, name, vendor, status, capabilities }] }
 *
 * This route REPLACES the legacy `POST`+`DELETE /api/areas/{areaId}/devices` pair. §9.2's rule for
 * every collection is `PUT` = full replace: the client states the membership it wants, the server
 * diffs, applies the diff in one transaction, refreshes derived state, and returns the new state.
 * That is not merely tidier than add/remove — an add and a remove issued separately have an
 * intermediate state that can violate the "at least one member" rule from either side, and a client
 * that wanted to swap the only member had no way to express it. Order is significant: the array index
 * becomes `area_members.ordinal`.
 *
 * The response is the SAME `members` list `GET /api/v4/areas/{id}` carries, from the same loader
 * (`lib/areas/v4-load.ts`), so a write-then-render client and a read-then-render client see one shape.
 *
 * 🛑 Removing a member also removes its now-orphaned BINDINGS (`replaceMembers`), and that leg is the
 * one that fails silently in both directions — see the DAO's header for why the proving case is a
 * two-member area with a binding on each.
 *
 * 🛑 One documented exception to "full replace": a `vendor='helper'` member is SERVER-MANAGED (the
 * battery-provenance writer mints it and binds the blend points onto it) and is never evicted by being
 * omitted. A client that read `members`, filtered to the devices its picker shows, and PUT the result
 * back would otherwise delete the area's blend bindings and blank its provenance card. See
 * `replaceMembers`.
 *
 * Owner or admin. 403 not yours / unreadable member · 404 unknown area · 409 area-of-one · 422 bad body.
 */
export async function PUT(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id } = await params;
  const authed = await loadAreaForOwner(request, id);
  if ("error" in authed) return authed.error;
  const { userId, isAdmin, area } = authed;

  const body = await request.json().catch(() => null);
  const members = await resolveMemberDeviceRefs(userId, isAdmin, body?.members);
  if (!members.ok)
    return NextResponse.json(
      { error: members.message },
      { status: members.status },
    );

  // A legacy Area addressed by a REAL device handle is that device's own area: its member set is the
  // device itself and cannot be restated without re-keying the handle. Carried over verbatim from the
  // legacy `POST /devices` guard, including its machine-readable `code`, but checked here on ANY change
  // rather than only on an add — restating the identical single member is the one no-op that is allowed
  // through, so an idempotent PUT of the current state never 409s.
  if (
    area.legacySystemId != null &&
    (await DeviceConfigRegistry.deviceByHandle(area.legacySystemId))
  ) {
    const current = await loadAreaMembers(area.id);
    const unchanged =
      current.length === members.deviceIds.length &&
      current.every((m, i) => m.id === members.deviceIds[i]);
    if (!unchanged) {
      return NextResponse.json(
        {
          error:
            "This is a single-device area. Create a site to combine it with other devices.",
          code: "AREA_OF_ONE_CANNOT_ADD",
        },
        { status: 409 },
      );
    }
  }

  try {
    await replaceMembers(area.id, members.deviceIds);
  } catch (err) {
    if (err instanceof AreaValidationError)
      return NextResponse.json({ error: err.message }, { status: 422 });
    throw err;
  }
  // 🛑 Membership IS the point set for a binding-less area, and the KV subscription registry is derived
  // from it — a PUT that skipped this would leave the area serving its OLD members' latest values.
  await refreshAreaServing(area.id);
  return NextResponse.json({
    members: areaMembersWire(await loadAreaMembers(area.id)),
  });
}
