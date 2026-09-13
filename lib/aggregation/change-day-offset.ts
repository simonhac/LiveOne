/**
 * Change a device's fixed day offset, and re-bucket everything rolled up on the old one.
 *
 * ## Why this is one operation and not two
 *
 * Changing the offset alone is a HALF operation, and it is the half that is invisible. The offset is
 * the boundary `point_readings_agg_1d` rolls up on, so moving it silently invalidates every daily
 * total the device has ever produced — the rows keep their `day` keys and keep answering, now
 * describing a window that no longer matches what the column says. `DeviceWriter.updateDevice` has
 * always been able to write the area's offset with nothing rebuilding behind it; this module is what
 * that path should have called.
 *
 * ## Why it deletes before it rebuilds
 *
 * `recomputeAgg1dForDay` is upsert-ONLY and emits a row only for a point with ≥1 in-day 5m reading.
 * Moving the boundary can leave a day with no readings that had one before — at either edge of the
 * history, or on the near side of a gap — and that day's old row would survive the rebuild, stale
 * and indistinguishable from a real one. Delete-then-rebuild is what makes the result a function of
 * the new offset alone. `ReadingsDao.delete1dForPointsInRange` is point-scoped and day-bounded
 * precisely so this can do that without touching another device or the 5m source.
 *
 * ## Why the window is measured, not typed
 *
 * Unlike `device recompute`, which requires a window and caps it at 31 days, a re-bucket has exactly
 * one correct window: the whole history. A partial re-bucket would leave the device's days split
 * across two boundaries with nothing recording where the seam is. So the span comes from
 * `agg1dSpanForPoints` and the caller does not get to choose it.
 */
import { CalendarDate } from "@internationalized/date";
import { and, eq, ne } from "drizzle-orm";
import type { planetscaleDb } from "@/lib/db/planetscale";
import {
  areaMembers,
  areas,
  devices,
  points as pointsTable,
} from "@/lib/db/planetscale/schema";
import { parseDateISO } from "@/lib/date-utils";
import { ReadingsDao } from "@/lib/readings/dao";
import { recomputeDerivedForDeviceDays } from "./scoped-recompute";

type PgDb = NonNullable<typeof planetscaleDb>;

export interface ChangeDayOffsetPlan {
  /** The offset the device buckets on today. */
  readonly currentOffsetMin: number;
  readonly newOffsetMin: number;
  /** `points.rid` for every point on the device. */
  readonly pointRids: number[];
  /**
   * The day window, and the `agg_1d` rows currently inside it.
   *
   * 🛑 `startDay`/`endDay` come from `agg_5m`, NOT from `agg_1d`. The op deletes `agg_1d`, so a window
   * derived from it would shrink on every pass and a resumed pass would reject its own `resumeFrom`.
   * `rows` is still the `agg_1d` count, because that is what the delete will remove and what the
   * operator wants reported.
   */
  readonly span: { startDay: string; endDay: string; rows: number } | null;
  readonly days: string[];
  /**
   * The area whose stored offset this will move with the device, and why it is safe to.
   *
   * Pre-resolver-flip the bucketing offset a rebuild reads is still the AREA's
   * (`DeviceConfigRegistry` projects `areas.timezone_offset_min` onto the device), so moving the
   * device without moving its area would be reverted by the next nightly aggregate. The area named
   * by `devices.primary_area_id` is the device's own area-of-one, so moving it is private to this
   * device — but that is an invariant worth CHECKING rather than assuming, because a shared area
   * would silently re-bucket its other members too.
   */
  readonly area: {
    id: string;
    name: string;
    offsetMin: number;
    /** Members other than this device and its area's helper. Non-empty ⇒ refuse. */
    otherMembers: string[];
  } | null;
}

export interface ChangeDayOffsetResult {
  readonly deleted1d: number;
  readonly agg1dDays: number;
  readonly provenanceAreas: number;
  /**
   * The first day NOT yet rebuilt, or `null` when the history is complete.
   *
   * 🛑 This is why the operation survives a serverless budget. Measured on a 357-day device, a
   * single-pass rebuild took 6m29s — past Vercel's 300 s ceiling, which would have killed it about
   * three quarters through and left the offset written, the rows deleted and no way to tell how far
   * it got. The work is chunked against a deadline instead, and the CALLER resumes: `liveone device
   * change-offset` loops on this field. The offset write and the delete happen once, on the first
   * pass, so a resumed pass is pure rebuild.
   */
  readonly nextDay: string | null;
}

/**
 * The local day an instant falls in, at a fixed offset, with a one-day margin applied by the caller.
 *
 * Deliberately approximate: the aggregation day runs 00:05..00:00-next-day, so an exact inverse has
 * an off-by-one at both edges. A margin day costs one `recomputeAgg1dForDay` that finds no readings
 * and writes nothing (~46 ms), which is a far better trade than a boundary day that never rebuilds.
 */
function localDay(ms: number, offsetMin: number): CalendarDate {
  const shifted = new Date(ms + offsetMin * 60_000);
  return new CalendarDate(
    shifted.getUTCFullYear(),
    shifted.getUTCMonth() + 1,
    shifted.getUTCDate(),
  );
}

/** Inclusive day list, ascending. */
function dayList(startDay: string, endDay: string): string[] {
  const first: CalendarDate = parseDateISO(startDay);
  const last: CalendarDate = parseDateISO(endDay);
  const out: string[] = [];
  for (let c = first; c.compare(last) <= 0; c = c.add({ days: 1 }))
    out.push(c.toString());
  return out;
}

/**
 * Work out what a re-bucket would touch, without touching it. Shared by the dry run and the apply so
 * the two cannot describe different operations.
 */
export async function planChangeDayOffset(
  db: PgDb,
  deviceRid: number,
  newOffsetMin: number,
): Promise<ChangeDayOffsetPlan> {
  const [device] = await db
    .select({
      uuid: devices.id,
      dayOffsetMin: devices.dayOffsetMin,
      areaId: devices.primaryAreaId,
    })
    .from(devices)
    .where(eq(devices.rid, deviceRid))
    .limit(1);
  if (!device) throw new Error(`no device with rid ${deviceRid}`);

  const pts = await db
    .select({ rid: pointsTable.rid })
    .from(pointsTable)
    .where(eq(pointsTable.deviceId, device.uuid));
  const pointRids = pts.map((p) => p.rid);

  // The WINDOW comes from the 5m source (stable across passes); the row COUNT from 1d (what the
  // delete will remove). See the `span` docstring.
  const [src, existing1d] = await Promise.all([
    ReadingsDao.agg5mSpanMsForPoints(pointRids, db),
    ReadingsDao.agg1dSpanForPoints(pointRids, db),
  ]);
  // The UNION of the two, so the delete cannot leave a stale 1d row sitting outside the 5m window
  // (a day whose readings were purged keeps its aggregate otherwise). Widening only adds days that
  // rebuild to nothing, at ~46 ms each.
  const from5m = src
    ? {
        startDay: localDay(src.minMs, newOffsetMin)
          .subtract({ days: 1 })
          .toString(),
        endDay: localDay(src.maxMs, newOffsetMin).add({ days: 1 }).toString(),
      }
    : null;
  const startDay =
    from5m && existing1d
      ? from5m.startDay < existing1d.startDay
        ? from5m.startDay
        : existing1d.startDay
      : (from5m?.startDay ?? existing1d?.startDay);
  const endDay =
    from5m && existing1d
      ? from5m.endDay > existing1d.endDay
        ? from5m.endDay
        : existing1d.endDay
      : (from5m?.endDay ?? existing1d?.endDay);
  const span =
    startDay && endDay
      ? { startDay, endDay, rows: existing1d?.rows ?? 0 }
      : null;

  const [areaRow] = await db
    .select({
      id: areas.id,
      name: areas.name,
      offsetMin: areas.timezoneOffsetMin,
    })
    .from(areas)
    .where(eq(areas.id, device.areaId))
    .limit(1);

  let area: ChangeDayOffsetPlan["area"] = null;
  if (areaRow) {
    // Everything in the area that is neither this device nor a helper. A helper is derived output of
    // the area itself, so it is not another tenant of the offset.
    const others = await db
      .select({ name: devices.name })
      .from(areaMembers)
      .innerJoin(devices, eq(devices.id, areaMembers.deviceId))
      .where(
        and(
          eq(areaMembers.areaId, areaRow.id),
          ne(areaMembers.deviceId, device.uuid),
          ne(devices.vendor, "helper"),
        ),
      );
    area = { ...areaRow, otherMembers: others.map((o) => o.name) };
  }

  return {
    currentOffsetMin: device.dayOffsetMin,
    newOffsetMin,
    pointRids,
    span,
    days: span ? dayList(span.startDay, span.endDay) : [],
    area,
  };
}

/**
 * Apply the plan: move the offset, drop the days it invalidated, rebuild them on the new boundary —
 * as much of the rebuild as fits in `deadlineMs`, resuming from `resumeFrom`.
 *
 * 🛑 NOT atomic across all three, and cannot be — the rebuild is hundreds of round trips and holding
 * a transaction open across it would pin a connection for minutes. The offset write IS transactional
 * and goes FIRST, so the only interruptible state is "offset correct, later days not yet rebuilt":
 * visible in `nextDay`, and resumable. The reverse order would leave the far worse state — rows
 * rebuilt on a boundary the device does not claim, indistinguishable from correct ones.
 *
 * `resumeFrom` skips both the offset write and the delete, because a resumed pass must not re-delete
 * the days an earlier pass already rebuilt.
 */
export async function applyChangeDayOffset(
  db: PgDb,
  deviceRid: number,
  plan: ChangeDayOffsetPlan,
  nowMs: number,
  opts: { resumeFrom?: string | null; deadlineMs: number },
): Promise<ChangeDayOffsetResult> {
  const resuming = !!opts.resumeFrom;
  const startIdx = opts.resumeFrom
    ? Math.max(0, plan.days.indexOf(opts.resumeFrom))
    : 0;

  if (resuming) {
    return rebuildChunk(
      db,
      deviceRid,
      plan,
      nowMs,
      startIdx,
      opts.deadlineMs,
      0,
    );
  }

  await db.transaction(async (tx) => {
    await tx
      .update(devices)
      .set({ dayOffsetMin: plan.newOffsetMin, updatedAt: new Date() })
      .where(eq(devices.rid, deviceRid));
    if (plan.area) {
      // Both columns, together — the coupling `updateAreaMeta` and `DeviceWriter.updateDevice`
      // already keep, and the one migration 0070's second gate asserts.
      await tx
        .update(areas)
        .set({
          timezoneOffsetMin: plan.newOffsetMin,
          dayOffsetMin: plan.newOffsetMin,
          updatedAt: new Date(),
        })
        .where(eq(areas.id, plan.area.id));
    }
  });

  let deleted1d = 0;
  if (plan.span) {
    const res = await ReadingsDao.delete1dForPointsInRange(
      plan.pointRids,
      { startDay: plan.span.startDay, endDay: plan.span.endDay },
      db,
    );
    deleted1d = res.deleted;
  }

  return rebuildChunk(
    db,
    deviceRid,
    plan,
    nowMs,
    0,
    opts.deadlineMs,
    deleted1d,
  );
}

/**
 * Rebuild days `[startIdx..]` until the deadline, in batches.
 *
 * Batched rather than day-at-a-time because `recomputeDerivedForDeviceDays` also refreshes the flow
 * matrix of every Area the device binds into, and doing that per day would be hundreds of redundant
 * refreshes. A batch is small enough that the deadline is honoured to within roughly one batch.
 */
async function rebuildChunk(
  db: PgDb,
  deviceRid: number,
  plan: ChangeDayOffsetPlan,
  nowMs: number,
  startIdx: number,
  deadlineMs: number,
  deleted1d: number,
): Promise<ChangeDayOffsetResult> {
  const BATCH = 20;
  let agg1dDays = 0;
  let provenanceAreas = 0;
  let i = startIdx;

  while (i < plan.days.length) {
    if (Date.now() >= deadlineMs) break;
    const batch = plan.days.slice(i, i + BATCH);
    const r = await recomputeDerivedForDeviceDays(
      db,
      // The NEW offset, passed explicitly rather than re-read: the rebuild must not depend on whether
      // a registry cache has caught up with the write.
      { id: deviceRid, timezoneOffsetMin: plan.newOffsetMin },
      batch,
      nowMs,
      "ChangeDayOffset",
    );
    agg1dDays += r.agg1dDays;
    provenanceAreas = Math.max(provenanceAreas, r.provenanceAreas);
    i += batch.length;
  }

  return {
    deleted1d,
    agg1dDays,
    provenanceAreas,
    nextDay: i < plan.days.length ? plan.days[i] : null,
  };
}

/** Offsets we accept: whole minutes, within ±14h, and a multiple of 15 minutes like every real zone. */
export function isValidDayOffsetMin(n: unknown): n is number {
  return (
    typeof n === "number" &&
    Number.isInteger(n) &&
    n >= -840 &&
    n <= 840 &&
    n % 15 === 0
  );
}
