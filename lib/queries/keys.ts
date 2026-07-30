/**
 * Query-key conventions for React Query.
 *
 * Every key starts `[resource, systemId, ...]` (systemId normalized to string) so a
 * manual Poll-Now / Amber-Sync can invalidate a whole device's data by resource, and
 * `invalidateDevice()` can sweep all of them.
 *
 * `rangeKey` distinguishes a LIVE trailing window from an explicit SETTLED past window:
 *   - live (no explicit start/end)  → the literal "live". The trailing window is advanced
 *     by `refetchInterval`, NOT by changing the key — putting `Date.now()` in the key would
 *     churn it every render and defeat dedup/caching.
 *   - settled (explicit start/end)  → `${start}_${end}`.
 */

/**
 * A subject's cache identity. `number` is the permanent integer handle (`?systemId=`); `string` covers
 * both its stringification and a wire-native TypeID (`dv_…` / `ar_…`), so a caller that already holds a
 * TypeID can key off it directly rather than round-tripping through a handle.
 *
 * 🛑 The key and the WIRE ADDRESS must move together. `dashboardDataBatchQuery` seeds
 * `queryKeys.data(id)` from the `{data: {[id]: …}}` map that `/api/data?systemId=a,b` returns — if the
 * request's id grammar and the key's disagree, the seed lands under a key nobody reads (a silent miss,
 * not a compile error), or under one already holding a different payload shape. That is why the batch
 * leg is deliberately `systemId`-only.
 */
export type SystemIdLike = number | string;

const sid = (systemId: SystemIdLike) => String(systemId);

/** Build the rangeKey for a (possibly absent) explicit window. */
export function rangeKeyFor(
  start?: string | null,
  end?: string | null,
): string {
  return start || end ? `${start ?? ""}_${end ?? ""}` : "live";
}

export const queryKeys = {
  /** Root for a device — `invalidateQueries({ queryKey: deviceRoot(id) })` is too broad;
   *  prefer the per-resource keys below. Kept for predicate-style sweeps. */
  all: ["system"] as const,

  /**
   * `/api/data` — the discriminated `{device|area, latest}` payload (config-v4 Phase 13 PR 1). The key
   * did NOT need a shape-version bump with that rename: there is no query-client persister in this app
   * (grep `persistQueryClient`), so every cache entry is created and read by ONE build — including the
   * SSR seed, which `getDeviceDataForCache` writes under this same key from the same build.
   */
  data: (systemId: SystemIdLike) => ["data", sid(systemId)] as const,

  /** `ids` must already be deduped + sorted (see `dashboardDataBatchQuery`) so the key is stable
   *  regardless of caller ordering. */
  dataBatch: (ids: string[]) => ["dataBatch", ids.join(",")] as const,

  latest: (systemId: SystemIdLike) => ["latest", sid(systemId)] as const,

  history: (
    systemId: SystemIdLike,
    interval: string,
    rangeKey: string,
    seriesKey: string,
  ) => ["history", sid(systemId), interval, rangeKey, seriesKey] as const,

  siteData: (systemId: SystemIdLike, period: string, rangeKey: string) =>
    ["siteData", sid(systemId), period, rangeKey] as const,

  /** The 1d attributed Sankey payload (`/api/history?interval=1d&include=sankey`) for a range of
   *  completed local days — e.g. the ev-provenance card's trailing-30-days window. */
  attributedFlowDaily: (
    systemId: SystemIdLike,
    startYMD: string,
    endYMD: string,
  ) => ["attributedFlowDaily", sid(systemId), startYMD, endYMD] as const,

  amber: (systemId: SystemIdLike, rangeKey: string) =>
    ["amber", sid(systemId), rangeKey] as const,

  runPeriods: (systemId: SystemIdLike, role: string, modeKey: string) =>
    ["runPeriods", sid(systemId), role, modeKey] as const,

  /** Keyed by AREA uuid (not systemId) — battery-provenance daily history for the panel. */
  provenanceDaily: (areaId: string, rangeKey: string) =>
    ["provenanceDaily", areaId, rangeKey] as const,
} as const;

/**
 * Resource keys that represent a device's live/historical data — used to invalidate
 * everything for a device after a manual poll or sync. Matches any query whose key's
 * second element equals the systemId for one of these resources.
 */
const SYSTEM_RESOURCES = [
  "data",
  "latest",
  "history",
  "siteData",
  "attributedFlowDaily",
  "amber",
  "runPeriods",
] as const;

/** Predicate for `invalidateQueries({ predicate })` — true for any of this device's data queries. */
export function isDeviceQuery(
  systemId: SystemIdLike,
  queryKey: readonly unknown[],
): boolean {
  return (
    typeof queryKey[0] === "string" &&
    (SYSTEM_RESOURCES as readonly string[]).includes(queryKey[0]) &&
    queryKey[1] === sid(systemId)
  );
}
