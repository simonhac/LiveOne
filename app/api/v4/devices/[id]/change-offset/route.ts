import { NextRequest, NextResponse } from "next/server";
import { eq } from "drizzle-orm";
import { requireDeviceAccess } from "@/lib/api-auth";
import { requirePlanetscaleDb } from "@/lib/db/planetscale";
import { devices as devicesTable } from "@/lib/db/planetscale/schema";
import { Device } from "@/lib/ids";
import {
  applyChangeDayOffset,
  isValidDayOffsetMin,
  planChangeDayOffset,
} from "@/lib/aggregation/change-day-offset";

/**
 * `POST /api/v4/devices/{id}/change-offset` — move a device's fixed day offset and re-bucket every
 * daily aggregate that was rolled up on the old one. For `liveone device change-offset`.
 *
 * This is the "explicit re-bucket op" `devices.day_offset_min` reserves in its schema comment, and
 * the ONLY sanctioned way to change that column. The column is otherwise immutable: it is the
 * boundary `point_readings_agg_1d` rolls up on, so a write without a rebuild leaves every daily total
 * the device ever produced describing a window its own `day` key no longer matches — silently, since
 * the rows keep answering.
 *
 * 🛑 **The window is NOT a parameter.** Its sibling `/recompute` requires one and caps it at 31 days;
 * here there is exactly one correct window — the whole history — because a partial re-bucket splits a
 * device's days across two boundaries with nothing recording where the seam is. The span is measured
 * from the data (`agg1dSpanForPoints`).
 *
 * 🛑 **Refuses when the device's area has other members.** Until the resolver flip the offset a
 * rebuild reads is still the AREA's, so this has to move the area's `timezone_offset_min` /
 * `day_offset_min` too or the next nightly aggregate reverts it. The area named by
 * `primary_area_id` is the device's own area-of-one, so that is private — but a shared area would
 * re-bucket its other members as collateral, so the invariant is checked rather than assumed.
 */

// Delete-then-rebuild over a device's whole 1d history. 300 s is the ceiling, not the budget: a
// measured 357-day device took 6m29s in one pass, so the work is chunked against REBUILD_BUDGET_MS
// and the caller resumes via `nextDay`. The headroom between the two is for the delete and the
// response.
export const maxDuration = 300;
const REBUILD_BUDGET_MS = 240_000;

const err = (message: string, status = 422) =>
  NextResponse.json({ error: message }, { status });

export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id } = await params;
  const uuid = Device.toUuidOrNull(id);
  if (!uuid) return err(`Invalid device id: ${id}`, 400);

  const db = requirePlanetscaleDb();
  const [row] = await db
    .select({ rid: devicesTable.rid })
    .from(devicesTable)
    .where(eq(devicesTable.id, uuid))
    .limit(1);
  // Unknown and not-readable are the same 404, as on `/recompute` and `/sync`: distinguishing them
  // would make this an existence oracle over other owners' devices.
  if (!row) return NextResponse.json({ error: "Not found" }, { status: 404 });

  const systemId = row.rid;
  const auth = await requireDeviceAccess(request, systemId, {
    requireWrite: true,
  });
  if (auth instanceof NextResponse) return auth;
  const device = auth.device;

  const body = (await request.json().catch(() => null)) as {
    dayOffsetMin?: unknown;
    dryRun?: unknown;
    resumeFrom?: unknown;
  } | null;
  if (!body) return err("Body must be JSON");

  if (!isValidDayOffsetMin(body.dayOffsetMin))
    return err(
      "dayOffsetMin must be a whole number of minutes, a multiple of 15, within ±840",
    );
  const newOffsetMin = body.dayOffsetMin;

  if (body.resumeFrom !== undefined && typeof body.resumeFrom !== "string")
    return err("resumeFrom must be a YYYY-MM-DD day");
  const resumeFrom = (body.resumeFrom as string | undefined) ?? null;

  const plan = await planChangeDayOffset(db, systemId, newOffsetMin);

  // On a RESUMED pass the offset already equals the target — that is what the first pass wrote — so
  // the "nothing to change" guard would reject exactly the calls that finish the job.
  if (!resumeFrom && plan.currentOffsetMin === newOffsetMin)
    return err(
      `device already buckets on ${newOffsetMin >= 0 ? "+" : ""}${newOffsetMin}m — nothing to change`,
    );
  if (resumeFrom && plan.currentOffsetMin !== newOffsetMin)
    return err(
      `cannot resume: device buckets on ${plan.currentOffsetMin}m, not the ${newOffsetMin}m being resumed`,
    );
  if (resumeFrom && !plan.days.includes(resumeFrom))
    return err(
      `cannot resume from ${resumeFrom}: not a day in this device's history`,
    );

  if (plan.area && plan.area.otherMembers.length > 0)
    return err(
      `area "${plan.area.name}" has other member device(s) — ${plan.area.otherMembers.join(", ")} — ` +
        `and its offset is shared with them, so changing it here would re-bucket their days too`,
    );

  const head = {
    device: {
      id,
      systemId,
      name: device.displayName,
      vendor: device.vendorType,
    },
    offset: { from: plan.currentOffsetMin, to: newOffsetMin },
    area: plan.area
      ? {
          id: plan.area.id,
          name: plan.area.name,
          offsetMin: plan.area.offsetMin,
        }
      : null,
    span: plan.span,
    days: plan.days.length,
    points: plan.pointRids.length,
  };

  // A dry run resolves and reports, and touches nothing. Everything above — the device exists, you
  // may write it, the offset is well-formed and different, the area is private to this device — has
  // already been checked, which is the part worth learning before committing to the delete.
  if (body.dryRun === true)
    return NextResponse.json({
      ...head,
      dryRun: true,
      deleted1d: 0,
      agg1dDays: 0,
      provenanceAreas: 0,
      nextDay: null,
    });

  const result = await applyChangeDayOffset(db, systemId, plan, Date.now(), {
    resumeFrom,
    deadlineMs: Date.now() + REBUILD_BUDGET_MS,
  });

  return NextResponse.json({ ...head, dryRun: false, ...result });
}
