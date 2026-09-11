/**
 * Shaping and arbitration for `liveone import` — the pure half of
 * `POST /api/v4/devices/{id}/import`.
 *
 * Lives outside the route because a Next App Router route file may only export HTTP verbs, and
 * every rule here is a decision worth testing on its own: which column a value lands in, whether a
 * counter's `delta` can be computed at all, and whether a row is allowed to displace what is
 * already stored.
 *
 * ## Why an import needs its own delta arithmetic
 *
 * For a `transform: 'd'` point the stored value is a monotonic COUNTER, and the quantity every
 * consumer actually reads is `delta` — `recomputeAgg1dForDay` sums `agg_5m.delta` to get a day's
 * energy. Nothing else will ever fill it in:
 *
 *   - `delta` is computed only when a 5m row is BUILT FROM RAW, against the previous interval's
 *     `last` (`recomputeAgg5mForIntervals` / `aggregate5mForPoint`), and an import writes `agg_5m`
 *     directly — there is no raw to build from.
 *   - `liveone device recompute` rebuilds `agg_1d` and the flow matrix, not `agg_5m`.
 *
 * So an import that left `delta` null would report every row written and produce no energy, ever.
 * 🛑 The fix is NOT to call `recomputeAgg5mForIntervals` afterwards: that rebuilds from raw, which
 * is empty across exactly the window an import exists to fill, so it would erase the import.
 *
 * The chain mirrors the raw path's rule exactly — `previousLast` is the IMMEDIATELY preceding
 * interval's `last`, from this batch if it is there and from the store otherwise, and a hole means
 * no `previousLast` and therefore a null `delta`. Differencing across a gap would attribute the
 * whole gap's energy to one 5-minute interval.
 *
 * ## Why the successor has to be repaired too
 *
 * The first stored row AFTER an imported run had its `delta` computed when nothing preceded it, so
 * it differences against the far side of the hole — or against nothing. Filling the hole changes
 * the right answer for that row, which is why the raw path expands every touched interval with
 * `withSuccessorIntervals`. Same reason, same fix, done here by hand.
 *
 * ## Why value placement is not `aggregate5mForPoint`
 *
 * That helper aggregates MANY raw samples into one interval, and for interval-energy points it
 * sums them and fills avg/min/max. An import supplies ONE already-aggregated value per interval, so
 * it follows `PointManager.insertPointReadingsAgg5m` instead — the same single-sample convention a
 * 5m-native vendor's rows arrive with. Only the counter `delta`, which that path leaves to the
 * recompute, has to be computed here.
 */
import { qualityRank } from "@/lib/data-quality";
import { FIVE_MIN_MS } from "@/lib/aggregation/point-aggregates";
import type { Agg5mInsert } from "@/lib/readings/dao";
import type { PointId } from "@/lib/ids";

/** One validated row from the wire, before it is shaped to the point's metric type. */
export interface ImportRow {
  point: PointId;
  intervalEndMs: number;
  value: number | null;
  valueStr: string | null;
}

/** The two point columns that decide where a value goes. */
export interface PointShape {
  metricType: string | null;
  transform: string | null;
}

/** What is already stored for one `(point, intervalEnd)`. */
export interface StoredRow {
  avg: number | null;
  min: number | null;
  max: number | null;
  last: number | null;
  delta: number | null;
  valueStr: string | null;
  sampleCount: number;
  errorCount: number;
  dataQuality: string | null;
  sessionId: string | null;
}

/**
 * What importing one row would do to the store. Two of the four block the request.
 *
 * `downgrade` — the supplied row is graded LOWER than what is stored: `interpolated` over a
 * vendor's `good`. Never an accident worth completing silently.
 *
 * `measured` — the stored row has NO marker but real samples behind it. 🛑 This is not a footnote:
 * for a RAW vendor (fusher, mondo, selectronic — every device this verb is likeliest to be pointed
 * at) `recomputeAgg5mForIntervals` writes `data_quality = NULL` on every row it builds, because the
 * aggregate of polled samples has no vendor marker to carry. Measured on the dev mirror, device 1
 * over one outage-adjacent hour: 207 rows, ALL of them `NULL`, `sample_count` 4–6.
 * `qualityRank(null)` is 0, so a rank comparison alone rates every one of those measurements below
 * an operator's guess — the protection would be inert exactly where it is needed. `sample_count`
 * is the tell: rank 0 means "nobody labelled it", not "there is nothing here".
 *
 * Both refuse the whole request unless it is asked for explicitly. `derive-power.ts` takes the same
 * position from the other side: it will upgrade its own estimates and will not touch a marker it
 * does not recognise, "so 'upgrade my own estimates' can never become 'overwrite someone's
 * measurement'".
 */
export type Disposition = "create" | "replace" | "downgrade" | "measured";

/** True when a disposition needs `overwriteMeasured` before it may proceed. */
export function isBlocking(d: Disposition): boolean {
  return d === "downgrade" || d === "measured";
}

export interface ShapedRow {
  insert: Agg5mInsert;
  disposition: Disposition;
  /** The marker being displaced, for the dry run's diff. Null when creating. */
  existingQuality: string | null;
}

export const storeKey = (point: PointId, intervalEndMs: number) =>
  `${point}|${intervalEndMs}`;

/**
 * Place one value into the 5m column tuple.
 *
 * Faithful to `PointManager.insertPointReadingsAgg5m`:
 *   - energy counter (`transform: 'd'`) → `last`; avg/min/max null; `delta` computed here.
 *   - interval energy                   → `delta`; avg/min/max/last null.
 *   - anything else                     → avg = min = max = last = value.
 */
function placeValue(
  shape: PointShape,
  value: number | null,
  valueStr: string | null,
  previousLast: number | undefined,
): Pick<
  Agg5mInsert,
  "avg" | "min" | "max" | "last" | "delta" | "sampleCount" | "errorCount"
> {
  const isError = value === null && valueStr === null;
  const isEnergyCounter =
    shape.metricType === "energy" && shape.transform === "d";
  const isEnergyDelta =
    shape.metricType === "energy" && shape.transform !== "d";
  const n = value;
  return {
    avg: isError || isEnergyCounter || isEnergyDelta ? null : n,
    min: isError || isEnergyCounter || isEnergyDelta ? null : n,
    max: isError || isEnergyCounter || isEnergyDelta ? null : n,
    last: isEnergyDelta || isError ? null : n,
    delta:
      isEnergyDelta && !isError
        ? n
        : // The counter case the raw path would have computed. Null without a contiguous
          // predecessor — see the header: no extrapolating a delta across a hole.
          isEnergyCounter &&
            !isError &&
            previousLast !== undefined &&
            n !== null
          ? n - previousLast
          : null,
    sampleCount: isError ? 0 : 1,
    errorCount: isError ? 1 : 0,
  };
}

export function isCounter(shape: PointShape): boolean {
  return shape.metricType === "energy" && shape.transform === "d";
}

/**
 * Shape every row, chain counter deltas, and classify each against what is stored.
 *
 * `stored` must cover `[min(intervalEnd) − 5min, max(intervalEnd) + 5min]` for every point in
 * `rows`: one interval below for the first delta's `previousLast`, one above for the successor
 * repair.
 */
export function shapeImportRows(args: {
  rows: ImportRow[];
  shapes: Map<PointId, PointShape>;
  stored: Map<string, StoredRow>;
  quality: string;
  sessionId: string;
}): { shaped: ShapedRow[]; successorRepairs: Agg5mInsert[] } {
  const { rows, shapes, stored, quality, sessionId } = args;

  // Group by point and sort ascending: a counter's delta depends on its predecessor, so the order
  // rows happen to appear in the operator's file must not change what is written.
  const byPoint = new Map<PointId, ImportRow[]>();
  for (const r of rows) {
    const list = byPoint.get(r.point);
    if (list) list.push(r);
    else byPoint.set(r.point, [r]);
  }
  for (const list of byPoint.values())
    list.sort((a, b) => a.intervalEndMs - b.intervalEndMs);

  const shaped: ShapedRow[] = [];
  const successorRepairs: Agg5mInsert[] = [];

  for (const [point, list] of byPoint) {
    const shape = shapes.get(point)!;
    const counter = isCounter(shape);
    // Values this batch writes, so a later interval can difference against an earlier one.
    const writtenLast = new Map<number, number | null>();

    for (const r of list) {
      let previousLast: number | undefined;
      if (counter) {
        const prevEnd = r.intervalEndMs - FIVE_MIN_MS;
        const fromBatch = writtenLast.get(prevEnd);
        if (fromBatch !== undefined && fromBatch !== null) {
          previousLast = fromBatch;
        } else if (!writtenLast.has(prevEnd)) {
          // Not in this batch — fall back to the store. `has` rather than a truthiness check, so a
          // batch row that deliberately wrote a null `last` is not silently replaced by an older
          // stored value.
          const prior = stored.get(storeKey(point, prevEnd));
          if (prior?.last != null) previousLast = prior.last;
        }
        writtenLast.set(r.intervalEndMs, r.value);
      }

      const placed = placeValue(shape, r.value, r.valueStr, previousLast);
      const existing = stored.get(storeKey(point, r.intervalEndMs));
      const disposition: Disposition = !existing
        ? "create"
        : qualityRank(quality) < qualityRank(existing.dataQuality)
          ? "downgrade"
          : // An unmarked row with samples behind it is a raw vendor's measurement, not an empty
            // slot. Checked BEFORE the rank tie, because `good` outranks null and would otherwise
            // sail past — and "I am confident about this" is not a licence to delete a measurement.
            existing.dataQuality === null && existing.sampleCount > 0
            ? "measured"
            : "replace";

      shaped.push({
        insert: {
          point,
          intervalEndMs: r.intervalEndMs,
          sessionId,
          valueStr: r.valueStr,
          dataQuality: quality,
          ...placed,
        },
        disposition,
        existingQuality: existing?.dataQuality ?? null,
      });
    }

    if (!counter) continue;

    // The successor: the first stored row after this run, whose delta was computed across the hole
    // this import just filled. Only its delta changes; every other column is written back as read.
    const lastRow = list[list.length - 1];
    const successorEnd = lastRow.intervalEndMs + FIVE_MIN_MS;
    if (writtenLast.has(successorEnd)) continue; // the batch covers it; already handled above
    const successor = stored.get(storeKey(point, successorEnd));
    if (!successor || successor.last == null || lastRow.value == null) continue;
    const delta = successor.last - lastRow.value;
    if (delta === successor.delta) continue; // already correct — do not touch the row
    successorRepairs.push({
      point,
      intervalEndMs: successorEnd,
      sessionId: successor.sessionId,
      avg: successor.avg,
      min: successor.min,
      max: successor.max,
      last: successor.last,
      delta,
      valueStr: successor.valueStr,
      sampleCount: successor.sampleCount,
      errorCount: successor.errorCount,
      dataQuality: successor.dataQuality,
    });
  }

  return { shaped, successorRepairs };
}
