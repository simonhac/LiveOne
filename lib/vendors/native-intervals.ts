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
export const FIVE_MIN_NATIVE_VENDOR_TYPES: ReadonlySet<string> = new Set([
  "amber",
  "enphase",
  "openelectricity",
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
