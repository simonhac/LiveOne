import { queryOptions } from "@tanstack/react-query";
import { fetchJson } from "./fetcher";
import { queryKeys, type SystemIdLike } from "./keys";
import type {
  RunPeriodColumns,
  RunSignalMeta,
} from "@/lib/run-tracking/run-period-view";

export type { RunPeriodColumns, RunSignalMeta };

/**
 * One persisted device run period, as shaped by `/api/system/{id}/run-periods`. Covers BOTH the
 * legacy generator-events fields and the richer enrichment (ISO times, duration, power). Consumers
 * read the subset they need.
 */
export interface RunPeriodEvent {
  date: string;
  startTime: string;
  endTime: string | null;
  running?: boolean;
  durationSeconds?: number | null;
  startTimeISO?: string;
  endTimeISO?: string | null;
  /**
   * Mean of the raw on-samples of the SIGNAL the detector follows, in `RunSignalMeta.unit` — rpm for
   * an engine-speed detector, W for a power one. Null when the row was written by an older detector
   * version, whose unit isn't provably the one `signal` describes.
   */
  avgSignal?: number | null;
  /** True average power over the run (W) — energy ÷ duration; null while still running. */
  avgPowerW?: number | null;
  sampleCount?: number;
  energyKwh: number;
}

/**
 * `/api/system/{id}/run-periods` response. The endpoint has two modes:
 *   - paged (`limit`/`offset`)  → `{ events, limit, offset, hasMore, running }`
 *   - period (`period`/`start&end`) → `{ events, totalEnergyKwh, running }`
 * so the mode-specific fields are optional.
 */
export interface RunPeriodsResponse {
  role: string;
  events: RunPeriodEvent[];
  /** What the detector follows (unit + label for `avgSignal`). Null when it can't be resolved. */
  signal?: RunSignalMeta | null;
  /** Which columns are honest for this detector — the server owns the rule, clients just obey it. */
  columns?: RunPeriodColumns;
  /** paged mode */
  limit?: number;
  offset?: number;
  hasMore?: boolean;
  /** period mode */
  totalEnergyKwh?: number;
  /** period mode: Σ duration of closed runs, so the footer can show Σenergy ÷ Σduration. */
  totalDurationSeconds?: number;
  running?: boolean;
}

export interface RunPeriodsQueryParams {
  systemId: SystemIdLike;
  /** Device role to read (e.g. "generator"; "pump" later). It is a query param, NOT a per-device route. */
  role: string;
  /** Paged mode: most-recent-first page of `limit` rows starting at `offset` (back through all history). */
  limit?: number;
  offset?: number;
  /** Period mode: a relative window like "30d" (default 30d when neither limit nor start/end given). */
  period?: string;
  /** Period mode: an explicit window (ISO or YYYY-MM-DD), both required together. */
  start?: string;
  end?: string;
  enabled?: boolean;
}

/** Build the run-periods URL for the requested mode (paged takes precedence over period/range). */
function buildRunPeriodsUrl(p: RunPeriodsQueryParams): string {
  let url = `/api/system/${p.systemId}/run-periods?role=${encodeURIComponent(p.role)}`;
  if (p.limit != null) {
    url += `&limit=${p.limit}&offset=${p.offset ?? 0}`;
  } else if (p.start && p.end) {
    url += `&start=${encodeURIComponent(p.start)}&end=${encodeURIComponent(p.end)}`;
  } else if (p.period) {
    url += `&period=${encodeURIComponent(p.period)}`;
  }
  return url;
}

/** Stable per-mode discriminator for the query key, so paged and period reads don't collide. */
function modeKey(p: RunPeriodsQueryParams): string {
  if (p.limit != null) return `paged:${p.limit}:${p.offset ?? 0}`;
  if (p.start && p.end) return `range:${p.start}_${p.end}`;
  return `period:${p.period ?? "30d"}`;
}

/**
 * Bounded, indexed read of a system's persisted device run periods (generator now, pump later).
 * The single shared accessor for `/api/system/{id}/run-periods` — replaces the per-component inline
 * fetches in GeneratorRunsCard and GeneratorClient so both share one key, param style, and
 * freshness policy. `role` is a query param, so this is a GENERIC resource, not a per-device API.
 *
 * Run periods are bounded tabular history (not live latest values), so a single staleTime with no
 * polling is right; a manual Poll-Now sweeps it via `invalidateSystem` (key resource "runPeriods").
 */
export function runPeriodsQuery(p: RunPeriodsQueryParams) {
  return queryOptions<RunPeriodsResponse>({
    queryKey: queryKeys.runPeriods(p.systemId, p.role, modeKey(p)),
    queryFn: () => fetchJson<RunPeriodsResponse>(buildRunPeriodsUrl(p)),
    staleTime: 60_000,
    placeholderData: (prev) => prev, // keep the current page visible while the next loads
    enabled: (p.enabled ?? true) && p.systemId != null && p.systemId !== "",
  });
}
