/**
 * Query-key conventions for React Query.
 *
 * Every key starts `[resource, systemId, ...]` (systemId normalized to string) so a
 * manual Poll-Now / Amber-Sync can invalidate a whole system's data by resource, and
 * `invalidateSystem()` can sweep all of them.
 *
 * `rangeKey` distinguishes a LIVE trailing window from an explicit SETTLED past window:
 *   - live (no explicit start/end)  → the literal "live". The trailing window is advanced
 *     by `refetchInterval`, NOT by changing the key — putting `Date.now()` in the key would
 *     churn it every render and defeat dedup/caching.
 *   - settled (explicit start/end)  → `${start}_${end}`.
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
  /** Root for a system — `invalidateQueries({ queryKey: systemRoot(id) })` is too broad;
   *  prefer the per-resource keys below. Kept for predicate-style sweeps. */
  all: ["system"] as const,

  data: (systemId: SystemIdLike) => ["data", sid(systemId)] as const,

  latest: (systemId: SystemIdLike) => ["latest", sid(systemId)] as const,

  history: (
    systemId: SystemIdLike,
    interval: string,
    rangeKey: string,
    seriesKey: string,
  ) => ["history", sid(systemId), interval, rangeKey, seriesKey] as const,

  siteData: (systemId: SystemIdLike, period: string, rangeKey: string) =>
    ["siteData", sid(systemId), period, rangeKey] as const,

  flowMatrix: (
    systemId: SystemIdLike,
    startYMD: string,
    endYMD: string,
    source: "legacy" | "modern" = "legacy",
  ) => ["flowMatrix", sid(systemId), startYMD, endYMD, source] as const,

  amber: (systemId: SystemIdLike, rangeKey: string) =>
    ["amber", sid(systemId), rangeKey] as const,

  runPeriods: (systemId: SystemIdLike, role: string, modeKey: string) =>
    ["runPeriods", sid(systemId), role, modeKey] as const,
} as const;

/**
 * Resource keys that represent a system's live/historical data — used to invalidate
 * everything for a system after a manual poll or sync. Matches any query whose key's
 * second element equals the systemId for one of these resources.
 */
const SYSTEM_RESOURCES = [
  "data",
  "latest",
  "history",
  "siteData",
  "flowMatrix",
  "amber",
  "runPeriods",
] as const;

/** Predicate for `invalidateQueries({ predicate })` — true for any of this system's data queries. */
export function isSystemQuery(
  systemId: SystemIdLike,
  queryKey: readonly unknown[],
): boolean {
  return (
    typeof queryKey[0] === "string" &&
    (SYSTEM_RESOURCES as readonly string[]).includes(queryKey[0]) &&
    queryKey[1] === sid(systemId)
  );
}
