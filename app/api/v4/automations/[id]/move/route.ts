/**
 * `POST /api/v4/automations/{au_…}/move` — re-home an automation onto another area.
 *
 * ## Why this is not `PATCH { areaId }`
 *
 * Because PATCH refuses one, on purpose, and that refusal is worth keeping: by the time the body is
 * read the route has already evaluated its area-owner check against the OLD area, so honouring an
 * `areaId` there would authorize a write against one area and perform it against another. A separate
 * verb asks both questions up front and has no such window. `automations.test.ts` pins the 422, and
 * it should keep passing.
 *
 * ## Why a move at all, rather than delete + recreate
 *
 * That is what PATCH's refusal suggests, and it is lossy in two ways nobody notices until later:
 *
 *   - the automation's uuid IS its calendar `UID` (`<uuid>@liveone.energy`,
 *     `…/calendar.ics/route.ts`). Recreating it makes every subscribed client drop the events and
 *     re-add them.
 *   - `last_triggered_run_start` records which schedule slot has already been consumed. A recreated
 *     rule has none, so a slot that already ran can arm again — for the generator exercise that is a
 *     second start of a diesel engine.
 *
 * ## Authorization: BOTH ends, like the device move
 *
 * This is deliberately the same doctrine as `PATCH /api/v4/devices/{id} { areaId }`, whose docstring
 * explains it at length: owning the thing being moved is not permission to put it somewhere.
 *
 *   - source — `loadOwnedAutomation`, owner-or-admin on the area it is leaving, 404-collapsed.
 *   - destination — `loadAreaForOwner`, because an automation placed in someone's area appears in
 *     that area's calendar feed and its `automation upcoming`.
 *   - the references, AGAINST THE DESTINATION — `checkReferences`, which is the control-plane
 *     firewall: it re-checks `derivationBelongsToArea` (the trigger's derivation must be owned by a
 *     device in the destination) and re-asserts ownership of the action point's device. A move is
 *     the one edit that can invalidate the first of those without touching the rule at all.
 *
 * 400 malformed id · 403 destination not yours · 404 no such automation OR not yours ·
 * 422 bad body, or the rule does not belong in the destination.
 */
import { NextRequest, NextResponse } from "next/server";
import { loadAreaForOwner } from "@/lib/areas/http";
import { Area } from "@/lib/ids";
import * as store from "@/lib/automations/store";
import { automationWire } from "@/lib/automations/wire";
import { checkReferences } from "@/lib/automations/references";
import {
  loadOwnedAutomation,
  notFound,
  unprocessable,
} from "@/lib/automations/http";

export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id } = await params;
  const loaded = await loadOwnedAutomation(request, id);
  if ("error" in loaded) return loaded.error;
  const { row } = loaded;

  const body = (await request.json().catch(() => null)) as {
    areaId?: unknown;
  } | null;

  // PRESENT and a string. There is no "unassign" for an automation — `automations.area_id` is NOT
  // NULL — so unlike the device move there is no null case to accept, and absent-means-something is
  // the shape that turns a typo into a silent write.
  if (!body || typeof body !== "object" || typeof body.areaId !== "string")
    return unprocessable("body must be { areaId: ar_… }");

  const destUuid = Area.toUuidOrNull(body.areaId);
  if (!destUuid) return unprocessable(`Invalid area id: ${body.areaId}`);

  if (destUuid === row.areaId)
    // A no-op, answered as success rather than refused: re-running a move that already happened is
    // exactly what a retried script does, and failing it would teach people to ignore the failure.
    return NextResponse.json({ moved: false, automation: automationWire(row) });

  const dest = await loadAreaForOwner(request, body.areaId);
  if ("error" in dest) {
    // 🛑 COLLAPSE the destination's 404 to 403, as `PATCH /api/v4/devices/{id} { areaId }` does.
    // `loadAreaForOwner` distinguishes "no such area" (404) from "not yours" (403), which is right
    // for a SUBJECT you already hold an id for and wrong for a DESTINATION you are proposing: an
    // authenticated caller could otherwise enumerate candidate `ar_` ids and learn which ones name
    // a real area from the status code alone. Authorization already prevents the placement; this
    // stops the endpoint being an existence oracle as well.
    const status = dest.error.status === 404 ? 403 : dest.error.status;
    return NextResponse.json(
      { error: "That destination area is not available to you" },
      { status },
    );
  }

  // 🛑 Against the DESTINATION. This is the check a move exists to re-run: `derivationBelongsToArea`
  // asks whether the trigger's derivation is owned by a device in the area, and that answer changes
  // precisely when the area does.
  // Returns the response to send, or null when everything checks out.
  const refusal = await checkReferences(
    request,
    dest.area.id,
    row.trigger,
    row.action,
  );
  if (refusal) return refusal;

  // 🛑 `?dryRun=true` returns AFTER every check and BEFORE the write. It exists so the CLI's dry run
  // exercises the real validation rather than describing an outcome the apply would refuse — the
  // destination's `derivationBelongsToArea` check in particular, which is the one that actually
  // fails in practice and which no read-only endpoint elsewhere answers.
  if (request.nextUrl.searchParams.get("dryRun") === "true")
    return NextResponse.json({
      moved: false,
      wouldMove: true,
      automation: automationWire(row),
    });

  // The revision OBSERVED before the checks above. `moveToArea` requires it to still hold.
  const moved = await store.moveToArea(row.id, dest.area.id, row.revision);
  if (!moved)
    // Either it was deleted or it was edited since `loadOwnedAutomation` read it. Both mean the
    // same thing to the caller and neither is a 500: what was validated is not what is there now.
    return NextResponse.json(
      {
        error: "That automation changed while the move was deciding",
        detail: {
          code: "stale-revision",
          expectedRevision: row.revision,
          fix: "re-read it and retry — the destination is validated against a specific version",
        },
      },
      { status: 409 },
    );

  return NextResponse.json({ moved: true, automation: automationWire(moved) });
}
