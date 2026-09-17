/**
 * `points.transform` applied — the one place that answers "what does this stored value mean?".
 *
 * ── THE PROBLEM THIS EXISTS FOR ──────────────────────────────────────────────────────────────────
 *
 * A `transform` of `'i'` means the stored column holds the vendor's sign, which is the INVERSE of
 * LiveOne's canonical `bidi.*` convention (positive = inflow/import — see
 * `docs/architecture/energy-flow-matrix.md`). Readers are expected to flip it.
 *
 * Five of them did, each with its own copy of `transform === "i" ? -v : v`:
 *   - `lib/history/build-series.ts`            (/api/history)
 *   - `lib/aggregation/flow-series.ts`         (the flow matrix, via `applyPowerTransform`)
 *   - `lib/battery-provenance/load.ts`         (the battery fold)
 *   - `lib/collectors/interval-comparison.ts`  (the Go-usher trial comparison)
 *   - `app/api/admin/devices/[systemId]/point-readings/route.ts`
 *
 * The SIXTH consumer — the KV latest-values cache, and so `/api/data` and every live dashboard
 * reading — did not. That is not a cosmetic inconsistency: `liveone device latest` and
 * `liveone device history` returned OPPOSITE SIGNS for the same point at the same instant, which
 * cost an afternoon and produced two confidently wrong conclusions about which way the data ran.
 *
 * ── WHY A HELPER RATHER THAN A DATA MIGRATION ────────────────────────────────────────────────────
 *
 * The tidier end state is one convention in the store, established at ingest, with no reader
 * flipping anything. That was attempted and abandoned — twice — and the reasons are worth keeping,
 * because they are not obvious and the idea will come back:
 *
 *  1. Normalising at ingest means rewriting ~534k historical rows for the one affected point, and
 *     the repair must distinguish old-decoder rows from new-decoder ones. Clock-based boundaries
 *     cannot: a poll firing after the cutover can carry a vendor timestamp from before it.
 *  2. `point_readings.session_id` CAN make that distinction exactly (a session records when we
 *     polled). But classifying rows is not the same as reaching them: with ingest live, a late
 *     message inserts a row behind the repair's cursor, which the scan never revisits and the
 *     completion guard then locks out.
 *  3. Quiescing ingest does not fix (2) either — `queue pause` stops dispatch, not polling — and
 *     stopping the poller would leave a permanent hole, because Selectronic is a live-poll vendor
 *     with no history endpoint to backfill from.
 *
 * Doing it properly needs version-aware normalisation at the receiver plus an idempotent repair.
 * That is a real project against the single writer of the serving store, to fix something that is
 * already consistent in five of six places. So: make the sixth agree, and keep the transform as
 * documented debt. `docs/architecture/point-transforms.md` records the whole decision.
 */

/** The transform vocabulary, as stored. */
export type PointTransform = "i" | "d" | "n" | null;

/**
 * A stored value in the convention its readers present.
 *
 * 🛑 ONLY `'i'` is a sign flip. `'d'` means "this counter is served as DELTAS rather than absolute
 * readings" — a different mechanism entirely, applied where series are built, and emphatically not
 * something to negate. Treating them alike would turn every energy counter upside down.
 *
 * Nulls and non-numerics pass through: a missing reading is not a zero, and a text point has no
 * sign to correct.
 */
export function canonicalValue<T>(
  value: T,
  transform: PointTransform | string | null | undefined,
): T {
  if (transform !== "i") return value;
  if (typeof value !== "number") return value;
  // `+ 0` normalises -0, which would otherwise round-trip through JSON as "-0".
  return (-value + 0) as T;
}
