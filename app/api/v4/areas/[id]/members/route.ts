import { NextRequest, NextResponse } from "next/server";
import { loadAreaForOwner, resolveMemberDeviceRefs } from "@/lib/areas/http";
import {
  replaceMembers,
  refreshAreaServing,
  AreaValidationError,
} from "@/lib/areas/create";
import { loadAreaMembers } from "@/lib/areas/v4-load";
import { areaMembersWire } from "@/lib/areas/v4-shapes";

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
 * An Area whose legacy integer handle ALSO names a device is no longer refused here. That guard was
 * carried over verbatim from the legacy `POST /devices` handler and protected nothing this codebase
 * still relies on: `lib/dashboard/subject.ts` pins a LOCKED device-first precedence for `?systemId=N`
 * (so growing such an area cannot widen the legacy alias), and `lib/kv-subjects.ts` deliberately reads
 * BOTH legs of a handle and unions them. The configuration it forbade already exists — `liveone-dev`
 * handle 13 is a real Sigenergy device AND a 3-member Area with 12 bindings — because server-managed
 * writers (the battery-provenance helper) never passed through this route. Retiring the integer handle
 * itself is the real fix and is scoped in `docs/plans/retire-the-integer-handle.md`.
 *
 * 🛑 One documented exception to "full replace": a `vendor='helper'` member is SERVER-MANAGED (the
 * battery-provenance writer mints it and binds the blend points onto it) and is never evicted by being
 * omitted. A client that read `members`, filtered to the devices its picker shows, and PUT the result
 * back would otherwise delete the area's blend bindings and blank its provenance card. See
 * `replaceMembers`.
 *
 * Owner or admin. 403 not yours / unreadable member · 404 unknown area · 422 bad body.
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
