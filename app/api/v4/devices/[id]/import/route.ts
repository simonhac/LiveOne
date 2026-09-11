import { NextRequest, NextResponse } from "next/server";
import { eq, and, inArray } from "drizzle-orm";
import { requireDeviceAccess } from "@/lib/api-auth";
import { requirePlanetscaleDb } from "@/lib/db/planetscale";
import {
  devices as devicesTable,
  points as pointsTable,
} from "@/lib/db/planetscale/schema";
import { Device, Point } from "@/lib/ids";
import type { PointId } from "@/lib/ids";
import { ReadingsDao, type Agg5mInsert } from "@/lib/readings";
import { KNOWN_QUALITIES } from "@/lib/data-quality";

/**
 * `POST /api/v4/devices/{id}/import` — write readings supplied by the caller, for `liveone import`.
 *
 * The manual sibling of `/sync`. A sync re-asks the VENDOR for a window and is the right answer
 * whenever the vendor still holds the data. This route is for the case a sync cannot serve: a value
 * no vendor will ever return again, that the operator has reconstructed from something else.
 *
 * 🛑 **`quality` is REQUIRED and has no default.** Every row here is being written on an operator's
 * say-so, so the one thing that must not be guessable is how much to trust it. A default would be
 * wrong in both directions: defaulting to `good` labels a reconstruction as a measurement, and
 * defaulting to `interpolated` mislabels a genuine measurement recovered from an export. Making the
 * caller say it is the entire point of the verb — `data_quality` is how a chart, a Sankey and the
 * "% estimated" accounting tell recovered data from measured, and it is the ONLY column that
 * carries that. It is validated against `KNOWN_QUALITIES`, an allow-list, because an unrecognised
 * marker is not rejected by the column: it would store fine, rank 0 in every arbitration, and read
 * as "provenance never recorded" forever after.
 *
 * 🛑 **Provenance belongs in `quality`, not in a free-text field, and NOT the other way round.**
 * `derive-power.ts` makes the matching point from the other side: the vendor's own historical power
 * samples are written `good`, because they are a measurement that arrived late rather than a
 * derivation — "using a quality marker to carry provenance is the mistake Amber's abbreviation
 * already made". So: grade the CONFIDENCE, not the route it came in by.
 *
 * 🛑 **Points are checked against the device in the path, not trusted from the body.** The device is
 * what authorisation was granted over; a `pt_…` in the body is caller-supplied and naming one that
 * belongs to a different device would otherwise be a write into a system this caller may not hold at
 * all. Any point that is not this device's is refused for the WHOLE request — partially applying an
 * import leaves the operator unable to tell which half landed.
 *
 * Writes are an UPSERT on `(point, interval_end)`, mirroring the observations receiver: importing
 * the same window twice converges rather than duplicating, and re-running after a correction is the
 * intended way to fix a bad import.
 */

// Importing a window is one batched statement per call; the wall-clock cost is the round trip plus
// the point lookup. The CLI chunks anything larger, so this does not need the backfill routes' 300.
export const maxDuration = 60;

/**
 * Rows per request. The CLI splits a larger file into this many at a time, so the cap is a limit on
 * one STATEMENT, not on what an operator can import.
 */
const MAX_ROWS = 5000;

const err = (message: string, status = 422) =>
  NextResponse.json({ error: message }, { status });

interface WireReading {
  point?: unknown;
  intervalEnd?: unknown;
  value?: unknown;
}

/** One validated row, before it is shaped to the point's metric type. */
interface Parsed {
  point: PointId;
  intervalEndMs: number;
  value: number | null;
  valueStr: string | null;
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
    .select({ rid: devicesTable.rid, uuid: devicesTable.id })
    .from(devicesTable)
    .where(eq(devicesTable.id, uuid))
    .limit(1);
  // Unknown and not-readable collapse to one 404, as on /sync and /recompute: distinguishing them
  // would make this an existence oracle over other owners' devices.
  if (!row) return NextResponse.json({ error: "Not found" }, { status: 404 });

  const auth = await requireDeviceAccess(request, row.rid, {
    requireWrite: true,
  });
  if (auth instanceof NextResponse) return auth;

  const body = (await request.json().catch(() => null)) as {
    interval?: unknown;
    quality?: unknown;
    readings?: unknown;
    dryRun?: unknown;
  } | null;
  if (!body) return err("Body must be JSON");

  // Only 5m is supported. Raw `point_readings` is the live poller's table and is recomputed INTO
  // agg_5m; importing raw would be overwritten by the next recompute of that interval, so accepting
  // it would be accepting a write that silently disappears.
  if (body.interval !== undefined && body.interval !== "5m")
    return err(
      `unsupported interval: ${String(body.interval)} — import writes 5m only`,
    );

  if (typeof body.quality !== "string")
    return err(`quality is required — one of: ${KNOWN_QUALITIES.join(", ")}`);
  if (!KNOWN_QUALITIES.includes(body.quality))
    return err(
      `unknown quality "${body.quality}" — one of: ${KNOWN_QUALITIES.join(", ")}`,
    );
  const quality = body.quality;

  if (!Array.isArray(body.readings)) return err("readings must be an array");
  if (body.readings.length === 0) return err("readings is empty");
  if (body.readings.length > MAX_ROWS)
    return err(
      `too many readings: ${body.readings.length} (max ${MAX_ROWS} per request)`,
    );

  // --- parse, strictly ---------------------------------------------------------------------------
  // Every row is validated before ANY is written. A per-row skip would turn a systematic mistake (a
  // mis-typed point, an off-by-one timezone) into a partial import that looks like a success.
  const parsed: Parsed[] = [];
  for (const [i, r] of (body.readings as WireReading[]).entries()) {
    const where = `readings[${i}]`;
    if (r == null || typeof r !== "object")
      return err(`${where} is not an object`);

    if (typeof r.point !== "string")
      return err(`${where}.point must be a pt_… point id`);
    if (!Point.is(r.point))
      return err(`${where}.point is not a valid point id: ${r.point}`);
    const point: PointId = r.point;

    if (typeof r.intervalEnd !== "string")
      return err(`${where}.intervalEnd must be an ISO timestamp`);
    const ms = Date.parse(r.intervalEnd);
    if (!Number.isFinite(ms))
      return err(
        `${where}.intervalEnd is not a parseable timestamp: ${r.intervalEnd}`,
      );
    // 5m rows are keyed on the interval END; an off-grid timestamp would create a row no reader
    // aligns to, so it is a caller error rather than something to round away silently.
    if (ms % 300_000 !== 0)
      return err(
        `${where}.intervalEnd is not on a 5-minute boundary: ${r.intervalEnd}`,
      );

    let value: number | null = null;
    let valueStr: string | null = null;
    if (typeof r.value === "number") {
      if (!Number.isFinite(r.value)) return err(`${where}.value is not finite`);
      value = r.value;
    } else if (typeof r.value === "string") {
      valueStr = r.value;
    } else if (r.value === null) {
      return err(
        `${where}.value is null — import writes values; to blank an interval, delete it`,
      );
    } else {
      return err(`${where}.value must be a number or a string`);
    }
    parsed.push({ point, intervalEndMs: ms, value, valueStr });
  }

  // --- authorise every point against THIS device -------------------------------------------------
  const wanted = [...new Set(parsed.map((p) => p.point))];
  const uuids = wanted
    .map((p) => Point.toUuidOrNull(p))
    .filter((u): u is string => u !== null);
  const known = await db
    .select({
      id: pointsTable.id,
      metricType: pointsTable.metricType,
      transform: pointsTable.transform,
      logicalPath: pointsTable.logicalPath,
      physicalPath: pointsTable.physicalPath,
      unit: pointsTable.unit,
    })
    .from(pointsTable)
    .where(
      and(eq(pointsTable.deviceId, row.uuid), inArray(pointsTable.id, uuids)),
    );
  const byUuid = new Map(known.map((k) => [k.id, k]));
  const foreign = wanted.filter((p) => !byUuid.has(Point.toUuidOrNull(p)!));
  if (foreign.length > 0)
    return err(
      `not this device's points: ${foreign.slice(0, 5).join(", ")}` +
        (foreign.length > 5 ? ` (+${foreign.length - 5} more)` : ""),
      403,
    );

  // --- shape to each point's metric type ---------------------------------------------------------
  // Mirrors PointManager.insertPointReadingsAgg5m: which COLUMN a single value belongs in is a
  // property of the point, not of the caller, so the caller sends one `value` and never has to know
  // that energy lands in `delta` while power lands in avg/min/max/last.
  const rows: Agg5mInsert[] = parsed.map((p) => {
    const meta = byUuid.get(Point.toUuidOrNull(p.point)!)!;
    const isError = p.value === null && p.valueStr === null;
    const isEnergyCounter =
      meta.metricType === "energy" && meta.transform === "d";
    const isEnergyDelta =
      meta.metricType === "energy" && meta.transform !== "d";
    const n = p.value;
    return {
      point: p.point,
      intervalEndMs: p.intervalEndMs,
      sessionId: null,
      avg: isError || isEnergyCounter || isEnergyDelta ? null : n,
      min: isError || isEnergyCounter || isEnergyDelta ? null : n,
      max: isError || isEnergyCounter || isEnergyDelta ? null : n,
      last: isEnergyDelta || isError ? null : n,
      delta: isEnergyDelta && !isError ? n : null,
      valueStr: p.valueStr,
      sampleCount: isError ? 0 : 1,
      errorCount: isError ? 1 : 0,
      dataQuality: quality,
    };
  });

  const summary = {
    device: { id, systemId: row.rid },
    interval: "5m" as const,
    quality,
    points: known.map((k) => ({
      id: Point.encode(k.id),
      logicalPath: k.logicalPath,
      metricType: k.metricType,
      unit: k.unit,
      rows: rows.filter((r) => Point.toUuidOrNull(r.point) === k.id).length,
    })),
    rows: rows.length,
    firstInterval: new Date(
      Math.min(...rows.map((r) => r.intervalEndMs)),
    ).toISOString(),
    lastInterval: new Date(
      Math.max(...rows.map((r) => r.intervalEndMs)),
    ).toISOString(),
  };

  if (body.dryRun === true)
    return NextResponse.json({ ...summary, dryRun: true, written: 0 });

  // UPSERT, full-fidelity — the same conflict handling the observations receiver uses for a
  // 5m-native vendor. Re-importing a window converges instead of duplicating, which is what makes
  // "fix the file and run it again" the correct way to repair a bad import.
  const { written } = await ReadingsDao.insert5m(rows, { upsert: true });

  console.log(
    `[Import] system ${row.rid}: ${written}/${rows.length} row(s) quality=${quality} ` +
      `${summary.firstInterval}..${summary.lastInterval}`,
  );

  return NextResponse.json({ ...summary, dryRun: false, written });
}
