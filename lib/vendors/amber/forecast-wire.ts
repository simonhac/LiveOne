/**
 * The wire shapes of `GET /api/v4/devices/{id}/forecasts` — shared by the route's reader
 * (`./forecast-store.ts`), `liveone device forecasts`, and `scripts/amber/forecast-accuracy.ts`.
 *
 * Deliberately free of any database import: the CLI and the script are HTTP clients, and they
 * import from here rather than from the store so that loading them never loads a DB client.
 */

/** Channel-scoped row kinds. `site` (spot + renewables) only appears in an as-of read. */
export const FORECAST_CHANNELS = [
  "general",
  "feedIn",
  "controlledLoad",
] as const;

/**
 * The most (interval × lead) rows one in-force request may return, across all its channels.
 *
 * 🛑 A response budget, not a DB one. Amber re-publishes nearly every interval on nearly every poll
 * (~170 stored revisions per interval per channel, measured Aug–Sep 2026), so at 25 leads almost
 * every pick is a distinct row: 38 days is ~47k rows per channel, ~11 MB of JSON — well past the
 * 4.5 MB a Vercel function may return. At ~230 bytes a row, this keeps a response under ~3.5 MB.
 * A caller that wants more leads splits them across requests (`scripts/amber/forecast-accuracy.ts` does).
 */
export const MAX_IN_FORCE_ROWS = 15_000;

/** One stored revision, as served. Times are ISO UTC; prices c/kWh incl. GST. */
export interface WireForecastRow {
  intervalEnd: string;
  observedAt: string;
  durationMin: number;
  perKwh: number | null;
  advLow: number | null;
  advPredicted: number | null;
  advHigh: number | null;
  descriptor: string | null;
  spikeStatus: string | null;
  /** `f` ForecastInterval, `c` CurrentInterval. */
  intervalType: string;
}

export interface WireInForceChannel {
  channel: string;
  /** Distinct interval ends with at least one stored revision in the window — the coverage base. */
  captured: string[];
  leads: { lead: number; rows: WireForecastRow[] }[];
}

export interface WireAsOfRow extends WireForecastRow {
  channel: string;
  /** `site` rows only. */
  spotPerKwh: number | null;
  renewables: number | null;
}

interface WireCaptureGap {
  prev: string;
  next: string;
  gapMin: number;
  pollsInside: number;
  failedInside: number;
  /** First error recorded inside the gap, truncated. */
  reason: string | null;
  /** `cron-missed` (no poll ran), `failed` (polls ran and failed), `sub-threshold` (ran, stored nothing). */
  verdict: "cron-missed" | "failed" | "sub-threshold";
}

export interface WireCaptureHealth {
  /** H1 — rows/captures over the window. `null` everywhere when nothing was captured. */
  rows: number;
  captures: number;
  firstObservedAt: string | null;
  lastObservedAt: string | null;
  minTarget: string | null;
  maxTarget: string | null;
  /** Minutes between the newest capture and the server's clock at read time. */
  newestAgeMin: number | null;
  /** H2 — polls that RAN (from `sessions`), not captures: a sub-threshold poll stores nothing. */
  polls: number;
  failedPolls: number;
  topError: string | null;
  expectedPollsPerHour: number;
  /** H3 — how far ahead of the poll the stored targets reach. */
  horizonMinHours: number | null;
  horizonMaxHours: number | null;
  /** H4 — gaps between captures beyond the store's `POLL_GAP_THRESHOLD_MIN`, longest first. */
  gapThresholdMin: number;
  gaps: WireCaptureGap[];
  /** H5 — per channel × interval type. */
  breakdown: {
    channel: string;
    intervalType: string;
    rows: number;
    targets: number;
    withPrice: number;
    withBand: number;
  }[];
}
