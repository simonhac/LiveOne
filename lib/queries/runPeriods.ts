import { queryOptions } from "@tanstack/react-query";
import { fetchJson } from "./fetcher";
import { queryKeys, type SystemIdLike } from "./keys";
import type {
  RunPeriodColumns,
  RunSignalMeta,
} from "@/lib/run-tracking/run-period-view";

export type { RunPeriodColumns, RunSignalMeta };

/**
 * One persisted device run period, as shaped by `/api/device/{id}/run-periods`. Covers BOTH the
 * legacy generator-events fields and the richer enrichment (ISO times, duration, power). Consumers
 * read the subset they need.
 */
export interface RunPeriodEvent {
  /** Start date ("EEE d MMM"), in the device's display timezone. */
  date: string;
  /** Start time ("h:mma", e.g. "4:16pm") — a DISPLAY string; read `startTimeISO` for the instant. */
  startTime: string;
  /** End time ("h:mma"); null for an open run. */
  endTime: string | null;
  /**
   * End date ("EEE d MMM"), present ONLY when the run ends on a different local day than it
   * started — so `formatRunWhen` can spell a midnight-crossing run out in full.
   */
  endDate?: string | null;
  running?: boolean;
  durationSeconds?: number | null;
  startTimeISO?: string;
  endTimeISO?: string | null;
  /**
   * Mean of the raw on-samples of the SIGNAL the detector follows, in `signalUnit` — rpm for an
   * engine-speed detector, W for a power one. Served for EVERY row since migration 0055: the unit
   * is stored per row, so there is no longer anything to infer and nothing to suppress.
   */
  avgSignal?: number | null;
  /**
   * The unit `avgSignal` is in, display-spelled ("rpm", "W"). Per EVENT rather than per response
   * because a single window can straddle a detector re-point and contain both — which is precisely
   * why the column header cannot be trusted to name the unit (see `columns.signalUnitPerRow`).
   */
  signalUnit?: string | null;
  /** True average power over the run (W) — energy ÷ duration; null while still running. */
  avgPowerW?: number | null;
  sampleCount?: number;
  energyKwh: number;
  /**
   * Per-run provenance, ACCUMULATED by the recompute against the run's own metered energy (see
   * lib/run-tracking/energy.ts). Null = unknown — the corresponding column is then absent from the
   * table entirely, never rendered as a zero.
   */
  costC?: number | null; // cents (signed) — formatDollars divides by 100
  emissionsG?: number | null; // grams CO₂ — formatKgCo2 wants kg, so ÷1000
  renewableKwh?: number | null; // kWh; shown as a % of the run's energy
}

/**
 * `/api/device/{id}/run-periods` response. The endpoint has two modes:
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
  /** period mode: provenance totals. Null when NO run in the window carried that figure. */
  totalCostC?: number | null;
  totalEmissionsG?: number | null;
  totalRenewableKwh?: number | null;
  /**
   * period mode: Σ energy of only those runs that carried each figure. Two uses: it is the honest
   * denominator for the renewable %, and comparing it against `totalEnergyKwh` tells the client
   * whether a total covers the whole window or only part of it (a window can straddle the moment
   * provenance was switched on) so it can be marked partial rather than read as complete.
   */
  costKnownKwh?: number;
  emissionsKnownKwh?: number;
  renewableKnownKwh?: number;
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
  let url = `/api/device/${p.systemId}/run-periods?role=${encodeURIComponent(p.role)}`;
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
 * Bounded, indexed read of a device's persisted device run periods (generator now, pump later).
 * The single shared accessor for `/api/device/{id}/run-periods` — replaces the per-component inline
 * fetches in GeneratorRunsCard and GeneratorClient so both share one key, param style, and
 * freshness policy. `role` is a query param, so this is a GENERIC resource, not a per-device API.
 *
 * Run periods are bounded tabular history (not live latest values), so a single staleTime with no
 * polling is right; a manual Poll-Now sweeps it via `invalidateDevice` (key resource "runPeriods").
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
