/**
 * 5m-native vendor classification.
 *
 * Most vendors (Selectronic, Fusher, Mondo, Tesla, …) emit **raw** point readings, from which the
 * 5-minute and daily aggregates are computed. A few vendors instead emit **pre-aggregated 5-minute**
 * data directly and have NO raw `point_readings` — these are "5m-native":
 *
 *   - **Amber** — sends late, multi-day `updateUsage` revisions (estimated → billable) that overwrite
 *     past 5m intervals.
 *   - **Enphase** — pulls per-day 5m series.
 *   - **Sigenergy** — HYBRID: its live 5-min poll writes raw POWER `point_readings` (recomputed in PG
 *     like any raw vendor), while a separate daily statistics job publishes queue-fed 5m ENERGY
 *     aggregates. It is listed here so the receiver UPSERTS that energy 5m. The raw power path is
 *     unaffected (the raw→5m recompute is per-point and never touches the queue-fed energy points).
 *
 * This matters for the aggregation path: raw-vendor 5m/1d are RECOMPUTED in Postgres from PG's own
 * raw, whereas 5m-native 5m is QUEUE-FED (the receiver mirrors what the vendor
 * published). The receiver must therefore UPSERT 5m-native 5m (so a re-published late refinement heals
 * the earlier copy) while keeping raw-vendor 5m first-write-wins (the PG recompute owns those).
 *
 * Keep this the single source of truth for the classification so the receiver, scripts, and any future
 * call site agree. See `lib/vendors/types.ts` `FetchResult.readingsAgg5m` ("Pre-aggregated (Enphase,
 * Amber)") and `docs/why-not-all-data-has-been-going-into-pg.md`.
 */

/** Vendor types that emit pre-aggregated 5-minute data directly (no raw `point_readings`). */
const FIVE_MIN_NATIVE_VENDOR_TYPES: ReadonlySet<string> = new Set([
  "amber",
  "enphase",
  "openelectricity",
  "sigenergy", // hybrid: raw power + queue-fed daily-statistics energy (see header)
]);

/**
 * True if the vendor type is 5m-native (Amber/Enphase) — i.e. its 5-minute aggregates arrive
 * pre-computed via the queue and must be UPSERTED in the PG mirror, not recomputed from raw.
 * Case-insensitive; null/undefined → false.
 */
export function isFiveMinuteNativeVendor(
  vendorType: string | null | undefined,
): boolean {
  if (!vendorType) return false;
  return FIVE_MIN_NATIVE_VENDOR_TYPES.has(vendorType.toLowerCase());
}

/**
 * How long ONE `point_readings_agg_5m` row actually covers, per vendor — the authority the flow
 * pipeline needs before it can treat an energy register's `delta` as a timeline slot's energy.
 *
 * 🛑 The table's name is a contract that one vendor breaks. For every RAW vendor the 5-minute bucket
 * is five minutes by construction (PG differences that vendor's raw readings into it), and the
 * 5m-native vendors above publish pre-aggregated five-minute rows — except **Amber**, whose usage and
 * price registers are natively HALF-HOURLY and land one row per 30 minutes in a table whose every
 * other row is five. Nothing about the row says so, which is how a half hour's energy came to be
 * attached to one five-minute slot as if it were that slot's own (`attachEnergyOverlays`): Kinkora Rd
 * 2026-09-08 read 15.77 kWh of grid export against 8.61 metered and 8.51 integrated, and the
 * `revenue_c` leg priced to match.
 *
 * 🛑 DECLARED, never inferred from the data. Detecting cadence by looking at row spacing is
 * defeatable — one adjacent pair of rows anywhere in a window makes a half-hourly register look
 * five-minutely, and a window holding a single row shows no spacing at all (which is the common case
 * for a Sankey tooltip over a short span). The duration is a property of the vendor's API, so it is
 * recorded here.
 *
 * Mirrors `cadenceMinutes` in the coverage-repair provider registry (Amber 30, OE/Sigenergy 5); kept
 * here rather than read from there so this module stays dependency-free — the flow-series loader
 * cannot pull the vendor adapters in. Adding a vendor with a coarser interval means adding it here;
 * the default is the table's own nominal five minutes.
 */
const AGG5M_INTERVAL_MS_BY_VENDOR: ReadonlyMap<string, number> = new Map([
  ["amber", 30 * 60_000],
]);

/** The nominal `point_readings_agg_5m` interval — what a row covers unless its vendor says otherwise. */
const AGG5M_NOMINAL_INTERVAL_MS = 5 * 60_000;

/** The interval one `agg_5m` row covers for this vendor. Case-insensitive; unknown → the nominal 5m. */
export function agg5mIntervalMs(vendorType: string | null | undefined): number {
  if (!vendorType) return AGG5M_NOMINAL_INTERVAL_MS;
  return (
    AGG5M_INTERVAL_MS_BY_VENDOR.get(vendorType.toLowerCase()) ??
    AGG5M_NOMINAL_INTERVAL_MS
  );
}
