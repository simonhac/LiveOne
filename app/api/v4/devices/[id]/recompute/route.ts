import { NextRequest, NextResponse } from "next/server";
import { CalendarDate } from "@internationalized/date";
import { requireDeviceAccess } from "@/lib/api-auth";
import { requirePlanetscaleDb } from "@/lib/db/planetscale";
import { devices as devicesTable } from "@/lib/db/planetscale/schema";
import { eq } from "drizzle-orm";
import { Device } from "@/lib/ids";
import { parseDateISO } from "@/lib/date-utils";
import { recomputeDerivedForDeviceDays } from "@/lib/aggregation/scoped-recompute";

/**
 * `POST /api/v4/devices/{id}/recompute` — rebuild what a device's days imply, for
 * `liveone device recompute`.
 *
 * The third step of a repair. A backfill publishes readings; the receiver lands them; and then the
 * things computed FROM those readings — `point_readings_agg_1d`, and the attributed flow matrix of
 * every Area the device's points bind into — are still describing the hole, because derived rows are
 * pure functions of their sources and nothing recomputes a past day on its own. `/sync` cannot do it
 * (it would have to wait for the lane to land, inside a 45 s budget it needs for the next window), so
 * it says so and this route is what it points at.
 *
 * 🛑 **There is no unscoped form, and "no window" is not one.** The window is REQUIRED and capped.
 * Its twin `/api/cron/daily` accepts `action=regenerate` with no date at all, which `parseDateParams`
 * resolves to *all available history* — a fleet-wide delete-and-reinsert reachable by omission. The
 * same shape is what let an unscoped derivation regenerate collapse 71 rows to 3. A verb whose
 * dangerous case is the one you get by typing less is a verb that will eventually be typed less.
 *
 * 🛑 **Scoped, deliberately.** This calls `recomputeDerivedForDeviceDays`, not `aggregateRange`. The
 * fleet sweep also re-runs HWS, battery learning, run periods and two backlog reheal passes, most of
 * them from the range start to NOW and none of them scoped to a device — measured on prod, a ONE-DAY
 * Sigenergy backfill spent an entire 300 s budget in it and returned an empty response. Finding days
 * that went stale for reasons unconnected to this repair is the nightly sweep's job.
 *
 * What it does NOT cover, and what does: RUN DETECTORS. Those are derivations, rebuilt by
 * `liveone derivation recompute <dx_…> --date=…` — also scoped, also with no unscoped form.
 */

// The per-day rebuild plus a flow refresh per bound Area is real work; give it the same headroom the
// other backfill routes carry.
export const maxDuration = 300;

/**
 * A month is the same cap `/api/cron/sigenergy-backfill` and `/api/cron/openelectricity-backfill`
 * use. It is not a performance limit so much as a shape one: a recompute spanning more than a month
 * is almost always a mis-typed year, and the cost of being wrong is a long delete-and-reinsert.
 */
const MAX_RANGE_DAYS = 31;

const err = (message: string, status = 422) =>
  NextResponse.json({ error: message }, { status });

/** Days from `a` to `b` inclusive. */
function daysBetween(a: CalendarDate, b: CalendarDate): number {
  return b.compare(a) + 1;
}

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
  // Unknown and not-readable are the same 404, as on `/sync`: distinguishing them would make this an
  // existence oracle over other owners' devices.
  if (!row) return NextResponse.json({ error: "Not found" }, { status: 404 });

  const systemId = row.rid;
  const auth = await requireDeviceAccess(request, systemId, {
    requireWrite: true,
  });
  if (auth instanceof NextResponse) return auth;
  const device = auth.device;

  const body = (await request.json().catch(() => null)) as {
    date?: unknown;
    start?: unknown;
    end?: unknown;
    dryRun?: unknown;
  } | null;
  if (!body) return err("Body must be JSON");

  // 🛑 `date` and `start`/`end` are alternatives, not a fallback chain. Accepting both and silently
  // preferring one means a caller who passed a range AND a date gets a rebuild of a window they can
  // see in their own command and did not get.
  const hasRange = body.start !== undefined || body.end !== undefined;
  if (body.date !== undefined && hasRange)
    return err("give either date, or start and end — not both");

  let first: CalendarDate;
  let last: CalendarDate;
  if (body.date !== undefined) {
    if (typeof body.date !== "string")
      return err("date must be a YYYY-MM-DD local day");
    try {
      first = last = parseDateISO(body.date);
    } catch {
      return err("date must be YYYY-MM-DD");
    }
  } else {
    if (typeof body.start !== "string" || typeof body.end !== "string")
      return err(
        "a window is required: either date, or both start and end, as YYYY-MM-DD local days",
      );
    try {
      first = parseDateISO(body.start);
      last = parseDateISO(body.end);
    } catch {
      return err("start and end must be YYYY-MM-DD");
    }
    if (last.compare(first) < 0)
      return err(`end (${body.end}) is before start (${body.start})`);
  }

  const days = daysBetween(first, last);
  if (days > MAX_RANGE_DAYS)
    return err(
      `window is ${days} days, and the cap is ${MAX_RANGE_DAYS} — split it, or use ` +
        `/api/cron/daily for a fleet-wide rebuild`,
    );

  const dayList: string[] = [];
  for (let c = first; c.compare(last) <= 0; c = c.add({ days: 1 }))
    dayList.push(c.toString());

  const head = {
    device: {
      id,
      systemId,
      name: device.displayName,
      vendor: device.vendorType,
    },
    window: { start: first.toString(), end: last.toString(), days },
    // The days are LOCAL to this device — the same boundaries the daily aggregates roll up on, which
    // for a device at a fixed offset is not the same set of instants as the caller's local days.
    timezoneOffsetMin: device.timezoneOffsetMin,
    days: dayList,
  };

  // A dry run resolves and reports the window and touches nothing. Everything above — the device
  // exists, you may write it, the window parses and is in range — has already been checked, which is
  // the part worth learning before committing to a delete-and-reinsert.
  if (body.dryRun === true)
    return NextResponse.json({
      ...head,
      dryRun: true,
      agg1dDays: 0,
      provenanceAreas: 0,
    });

  // Best-effort per day and per Area by design (see `scoped-recompute.ts`): one day failing is logged
  // and the rest proceed, so the counts below are the measurement, not the request echoed back.
  const result = await recomputeDerivedForDeviceDays(
    db,
    { id: systemId, timezoneOffsetMin: device.timezoneOffsetMin },
    dayList,
    Date.now(),
    "DeviceRecompute",
  );

  return NextResponse.json({
    ...head,
    dryRun: false,
    agg1dDays: result.agg1dDays,
    provenanceAreas: result.provenanceAreas,
  });
}
