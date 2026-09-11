import { NextRequest, NextResponse } from "next/server";
import { eq, and, inArray, sql } from "drizzle-orm";
import { requireDeviceAccess } from "@/lib/api-auth";
import { requirePlanetscaleDb } from "@/lib/db/planetscale";
import {
  devices as devicesTable,
  points as pointsTable,
  sessions as sessionsTable,
} from "@/lib/db/planetscale/schema";
import { Device, Point } from "@/lib/ids";
import type { PointId } from "@/lib/ids";
import { ReadingsDao, type Agg5mInsert } from "@/lib/readings";
import { IMPORTABLE_QUALITIES } from "@/lib/data-quality";
import { FIVE_MIN_MS } from "@/lib/aggregation/point-aggregates";
import {
  isBlocking,
  shapeImportRows,
  storeKey,
  type ImportRow,
  type PointShape,
  type StoredRow,
} from "@/lib/readings/import-rows";

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
 * carries that. It is validated against `IMPORTABLE_QUALITIES`, which is deliberately NARROWER than
 * the set this codebase can read: an operator must not be able to choose `unknown`, `.`, or one of
 * Amber's storage abbreviations. See `lib/data-quality.ts`.
 *
 * 🛑 **`sessionId` is REQUIRED, and it is what makes `quality` honest.** Grade the CONFIDENCE in a
 * number, not the route it arrived by — `derive-power.ts` writes a vendor's own late-arriving
 * samples as `good` for exactly that reason, and it can, because "which rows arrived this way is
 * answerable from `session_id`". Without a session that sentence is false: a `good` import would be
 * permanently indistinguishable from a live measurement, and `good` would become laundering. So the
 * operator creates the session first (`liveone session create`, which requires a label and carries
 * a manifest in `sessions.response`) and every row here is stamped with it. The session must belong
 * to THIS device — `sessions.device_rid` is not nullable and a foreign one would file this import
 * under someone else's provenance.
 *
 * 🛑 **Points are checked against the device in the path, not trusted from the body.** The device is
 * what authorisation was granted over; a `pt_…` in the body is caller-supplied and naming one that
 * belongs to a different device would otherwise be a write into a system this caller may not hold at
 * all. Any point that is not this device's is refused for the WHOLE request — partially applying an
 * import leaves the operator unable to tell which half landed.
 *
 * 🛑 **An UPSERT can destroy a measurement, so this one arbitrates first.** Writes are an UPSERT on
 * `(point, interval_end)` — which is what makes "fix the file and run it again" the right way to
 * repair a bad import — but an unguarded one would also let `interpolated` silently overwrite a
 * vendor's `good` reading, with nothing downstream able to tell afterwards. Every row is classified
 * against what is stored (`create` / `replace` / `downgrade`) before anything is written, the dry
 * run reports the three counts rather than "rows in your file", and a `downgrade` refuses the whole
 * request unless `overwriteMeasured` asks for it.
 *
 * 🛑 **`intervalStart` or `intervalEnd` — say which.** 5m rows are keyed on the interval END, and
 * the two plausible sources of an operator's file DISAGREE about which they stamp: `liveone device
 * history --format csv` emits `timestamp_utc` as the interval END, while both vendor archives stamp
 * the START. Every one of those values lands on a 5-minute boundary, so passing either as the wrong
 * field validates cleanly and shifts every row by a whole interval — the "plausible-looking import
 * against the wrong hour" that nothing downstream can detect. Exactly one of the two fields must be
 * present, and there is deliberately no default.
 */

// Importing a window is one batched statement per call; the wall-clock cost is the round trip plus
// the point lookup and the arbitration read. The CLI chunks anything larger.
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
  intervalStart?: unknown;
  value?: unknown;
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
    sessionId?: unknown;
    readings?: unknown;
    dryRun?: unknown;
    overwriteMeasured?: unknown;
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
    return err(
      `quality is required — one of: ${IMPORTABLE_QUALITIES.join(", ")}`,
    );
  if (!IMPORTABLE_QUALITIES.includes(body.quality))
    return err(
      `unknown quality "${body.quality}" — one of: ${IMPORTABLE_QUALITIES.join(", ")}`,
    );
  const quality = body.quality;

  if (typeof body.sessionId !== "string" || body.sessionId.length === 0)
    return err(
      "sessionId is required — create one with `liveone session create` so these rows " +
        "carry a label and a manifest saying where they came from",
    );
  const [session] = await db
    .select({ id: sessionsTable.id, deviceRid: sessionsTable.deviceRid })
    .from(sessionsTable)
    .where(eq(sessionsTable.id, body.sessionId))
    .limit(1);
  if (!session) return err(`no such session: ${body.sessionId}`);
  if (session.deviceRid !== row.rid)
    return err(
      `session ${body.sessionId} belongs to device ${session.deviceRid}, not ${row.rid}`,
      403,
    );
  const sessionId = session.id;

  const overwriteMeasured = body.overwriteMeasured === true;

  if (!Array.isArray(body.readings)) return err("readings must be an array");
  if (body.readings.length === 0) return err("readings is empty");
  if (body.readings.length > MAX_ROWS)
    return err(
      `too many readings: ${body.readings.length} (max ${MAX_ROWS} per request)`,
    );

  // --- parse, strictly ---------------------------------------------------------------------------
  // Every row is validated before ANY is written. A per-row skip would turn a systematic mistake (a
  // mis-typed point, an off-by-one timezone) into a partial import that looks like a success.
  const parsed: ImportRow[] = [];
  for (const [i, r] of (body.readings as WireReading[]).entries()) {
    const where = `readings[${i}]`;
    if (r == null || typeof r !== "object")
      return err(`${where} is not an object`);

    if (typeof r.point !== "string")
      return err(`${where}.point must be a pt_… point id`);
    if (!Point.is(r.point))
      return err(`${where}.point is not a valid point id: ${r.point}`);
    const point: PointId = r.point;

    const hasEnd = r.intervalEnd !== undefined;
    const hasStart = r.intervalStart !== undefined;
    if (hasEnd === hasStart)
      return err(
        `${where} must carry exactly one of intervalEnd or intervalStart — ` +
          "a 5m row is keyed on the END; the vendor archives stamp the START and `device history` " +
          "stamps the END, " +
          "and both land on 5-minute boundaries, so guessing would silently shift every row",
      );
    const stamp = hasEnd ? r.intervalEnd : r.intervalStart;
    const field = hasEnd ? "intervalEnd" : "intervalStart";
    if (typeof stamp !== "string")
      return err(`${where}.${field} must be an ISO timestamp`);
    const ms = Date.parse(stamp);
    if (!Number.isFinite(ms))
      return err(`${where}.${field} is not a parseable timestamp: ${stamp}`);
    // 5m rows are keyed on the interval END; an off-grid timestamp would create a row no reader
    // aligns to, so it is a caller error rather than something to round away silently.
    if (ms % FIVE_MIN_MS !== 0)
      return err(`${where}.${field} is not on a 5-minute boundary: ${stamp}`);
    const intervalEndMs = hasEnd ? ms : ms + FIVE_MIN_MS;

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
    parsed.push({ point, intervalEndMs, value, valueStr });
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

  const shapes = new Map<PointId, PointShape>(
    wanted.map((p) => {
      const m = byUuid.get(Point.toUuidOrNull(p)!)!;
      return [p, { metricType: m.metricType, transform: m.transform }];
    }),
  );

  // --- read what is already there ----------------------------------------------------------------
  // One interval either side of the run: below for a counter's first `previousLast`, above for the
  // successor whose delta this import invalidates. See `lib/readings/import-rows.ts`.
  const minEnd = Math.min(...parsed.map((p) => p.intervalEndMs));
  const maxEnd = Math.max(...parsed.map((p) => p.intervalEndMs));
  const existingByPoint = await ReadingsDao.read5m(
    wanted,
    { fromMs: minEnd - FIVE_MIN_MS, toMs: maxEnd + FIVE_MIN_MS },
    db,
  );
  const stored = new Map<string, StoredRow>();
  for (const [point, rows] of existingByPoint)
    for (const r of rows) stored.set(storeKey(point, r.intervalEndMs), r);

  const { shaped, successorRepairs } = shapeImportRows({
    rows: parsed,
    shapes,
    stored,
    quality,
    sessionId,
  });

  const created = shaped.filter((s) => s.disposition === "create").length;
  const replaced = shaped.filter((s) => s.disposition === "replace").length;
  const blocked = shaped.filter((s) => isBlocking(s.disposition));
  const downgrades = shaped.filter((s) => s.disposition === "downgrade");
  const overMeasured = shaped.filter((s) => s.disposition === "measured");

  const summary = {
    device: { id, systemId: row.rid },
    interval: "5m" as const,
    quality,
    sessionId,
    points: known.map((k) => {
      const p = Point.encode(k.id);
      const mine = shaped.filter((s) => s.insert.point === p);
      return {
        id: p,
        logicalPath: k.logicalPath,
        metricType: k.metricType,
        unit: k.unit,
        rows: mine.length,
        created: mine.filter((s) => s.disposition === "create").length,
        replaced: mine.filter((s) => s.disposition === "replace").length,
        downgraded: mine.filter((s) => s.disposition === "downgrade").length,
        overMeasured: mine.filter((s) => s.disposition === "measured").length,
      };
    }),
    rows: shaped.length,
    created,
    replaced,
    // The markers that would be displaced, so the refusal below names what is at stake.
    downgraded: downgrades.length,
    downgradesOver: [
      ...new Set(downgrades.map((d) => d.existingQuality ?? "(none)")),
    ].sort(),
    /** Unmarked rows with samples behind them — a raw vendor's own measurement. */
    overMeasured: overMeasured.length,
    successorDeltasRepaired: successorRepairs.length,
    firstInterval: new Date(minEnd).toISOString(),
    lastInterval: new Date(maxEnd).toISOString(),
  };

  // 🛑 Refuse BEFORE writing anything, and refuse the whole request. A partial apply would leave the
  // operator unable to tell which measurements survived.
  if (blocked.length > 0 && !overwriteMeasured) {
    const reasons = [
      downgrades.length > 0
        ? `${downgrades.length} would replace a better-graded reading (${summary.downgradesOver.join(", ")}) with "${quality}"`
        : null,
      overMeasured.length > 0
        ? `${overMeasured.length} would replace an unmarked reading that has real samples behind it — ` +
          "a raw vendor's aggregate carries no quality marker, so it ranks 0 without being empty"
        : null,
    ].filter(Boolean);
    return NextResponse.json(
      {
        ...summary,
        error:
          `${blocked.length} row(s) would overwrite existing readings: ${reasons.join("; ")}. ` +
          "Nothing was written. Re-run with overwriteMeasured if that is genuinely intended.",
      },
      { status: 409 },
    );
  }

  if (body.dryRun === true)
    return NextResponse.json({ ...summary, dryRun: true, written: 0 });

  // UPSERT, full-fidelity — the same conflict handling the observations receiver uses for a
  // 5m-native vendor. Re-importing a window converges instead of duplicating, which is what makes
  // "fix the file and run it again" the correct way to repair a bad import.
  const inserts: Agg5mInsert[] = shaped.map((s) => s.insert);
  const { written } = await ReadingsDao.insert5m(inserts, { upsert: true });

  // The successor's delta, recomputed against the run this import just filled. `preserveVendorMeta`
  // because this write owns the value columns only — the row's own session, quality and value_str
  // belong to whoever originally wrote it.
  let repaired = 0;
  if (successorRepairs.length > 0) {
    ({ written: repaired } = await ReadingsDao.insert5m(
      successorRepairs,
      { upsert: true, preserveVendorMeta: true },
      db,
    ));
  }

  // Account the rows against the session, so the provenance record says how much it covers rather
  // than only that it exists. Additive because an import is chunked — each request adds its own.
  await db
    .update(sessionsTable)
    .set({ numRows: sql`${sessionsTable.numRows} + ${written}` })
    .where(eq(sessionsTable.id, sessionId));

  console.log(
    `[Import] system ${row.rid}: ${written}/${inserts.length} row(s) quality=${quality} ` +
      `session=${sessionId} created=${created} replaced=${replaced} ` +
      `successorDeltas=${repaired} ${summary.firstInterval}..${summary.lastInterval}`,
  );

  return NextResponse.json({
    ...summary,
    dryRun: false,
    written,
    successorDeltasRepaired: repaired,
  });
}
