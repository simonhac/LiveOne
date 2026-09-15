/**
 * `GET /api/v4/devices/{dv_…}/dependents` — what still references this device, named. Read-only.
 *
 * The device twin of the area endpoint next door, and it exists for the same reason: so a DRY RUN
 * can tell the truth. `liveone device archive` and `liveone device delete` are dry-run by default,
 * and without this they could only print "would DELETE" and then have `--apply` come back 409 — a
 * preview that promises something the real thing deterministically refuses, which teaches an
 * operator to skip the preview.
 *
 * Same `findDependents` the writer uses, so the two cannot drift about what counts. What it cannot
 * promise is that the answer is still true a moment later: `hardDeleteDevice` re-scans under a
 * `FOR UPDATE` lock precisely because this one cannot. The preview is advisory; the refusal is the
 * guarantee.
 *
 * `?destructive=true` asks the DELETE question — derivations reading or writing this device's
 * points, area bindings selecting them, managed pollers, point commands. Without it, the ARCHIVE
 * question: config references only, because archiving destroys nothing.
 */
import { NextRequest, NextResponse } from "next/server";
import { eq } from "drizzle-orm";
import { loadDeviceForOwner } from "@/lib/devices/http";
import { findDependents } from "@/lib/integrity/relied-upon";
import { requirePlanetscaleDb } from "@/lib/db/planetscale";
import { points } from "@/lib/db/planetscale/schema";
import { ReadingsDao } from "@/lib/readings";

export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id } = await params;
  const authed = await loadDeviceForOwner(request, id);
  if ("error" in authed) return authed.error;
  const { device } = authed;

  const destructive =
    request.nextUrl.searchParams.get("destructive") === "true";

  const dependents = await findDependents("device", device.uuid, {
    destructive,
  });

  // 🛑 The EXTENT of what a delete would destroy, and only on the destructive question.
  //
  // The refusal list says what would BLOCK a delete. It says nothing about what a successful one
  // costs, and for a device that is the whole decision — the owned history goes without a refusal by
  // design. So the preview carries it, or `device delete`'s dry run is an informed confirmation in
  // name only.
  //
  // A SPAN, not a count: `point_readings` is the largest table here and `COUNT(*)` over a year of
  // one device's minutely history is a seconds-long scan (the shape that already has `area
  // provenance` timing out on prod). `min`/`max` ride the `(point_rid, measurement_time)` index, and
  // a date range is the more useful number anyway.
  let extent: {
    points: number;
    readings: { minMs: number; maxMs: number } | null;
  } | null = null;
  if (destructive) {
    const own = await requirePlanetscaleDb()
      .select({ rid: points.rid })
      .from(points)
      .where(eq(points.deviceId, device.uuid));
    const rids = own.map((p) => p.rid);
    extent = {
      points: rids.length,
      readings: await ReadingsDao.rawSpanMsForPoints(rids),
    };
  }

  return NextResponse.json({
    deviceId: id,
    status: device.status,
    destructive,
    dependents,
    extent,
  });
}
