/**
 * Coverage-repair framework — shared types + the per-vendor provider contract.
 *
 * Repair is a two-stage process: (1) find coverage gaps in a date range [generic, read-only], then
 * (2) backfill them by re-fetching from the vendor API [per-vendor]. Each external-API vendor
 * (Amber, OpenElectricity, Sigenergy) supplies a `CoverageRepairProvider`; the generic runner
 * (lib/coverage/runner.ts) drives both stages uniformly. See lib/coverage/find-gaps.ts + runner.ts.
 */
import type { PointId } from "@/lib/ids";
import type { DeviceConfigView } from "@/lib/registry/device-config";
import type { SessionInfo } from "@/lib/point/point-manager";
import type { PollCollector } from "@/lib/observations/poll-collector";

/** A coverage point resolved to its internal rid and its registry identity. */
export interface CoveragePoint {
  /** `points.rid` — globally unique. Was `point_info.index` until the config-v4 pre-terminal prep. */
  id: number;
  tail: string; // physical_path_tail, e.g. "E1/kwh", "nem/price", "solar_interval_wh"
  /** The point's registry identity, carried from the same row `id`/`tail` came from. The readings
   *  DAO is keyed on this, so carrying it removes a `RegistryCache.pointForAddr` round trip per
   *  point — and with it the "point absent from the registry" branch, which the NOT NULL
   *  `point_uid` makes unreachable once the row itself is in hand (config-v4 Phase 12 slice D). */
  point: PointId;
}

export interface PointShortfall {
  tail: string;
  /** `points.rid` (diagnostic only). */
  pointId: number;
  present: number;
  missing: number;
}

/** A local trading day that is short on at least one coverage point. */
export interface CoverageGapDay {
  day: string; // local 'YYYY-MM-DD' in the provider's bucket timezone
  maxMissing: number; // worst shortfall across coverage points (= expected → whole day missing)
  maxPresent: number; // best present-count that day (carried into the progress-based landing check)
  points: PointShortfall[]; // only points that are short
}

export type RepairStatus = "repaired" | "unsettled" | "error" | "would-repair";

/** Outcome of attempting to backfill one gap-day. */
export interface DayRepair {
  systemId: number;
  day: string;
  publishedRows: number;
  status: RepairStatus;
  error?: string;
}

/** Result of `prepare()` — either a ready backfill context, or a reason it can't run. */
export type PrepareResult<C> =
  | { ok: true; ctx: C }
  | { ok: false; error: string };

/**
 * A vendor's plug-in for the coverage-repair framework. Implementations live vendor-scoped in
 * lib/vendors/<vendor>/coverage-repair.ts and are registered in lib/coverage/providers.ts.
 */
export interface CoverageRepairProvider<Ctx = unknown> {
  vendorType: string; // "amber" | "openelectricity" | "sigenergy"
  cadenceMinutes: number; // data interval spacing (NOT poll cadence): Amber 30, OE/Sigen 5
  lookbackDays: number; // gap-find window: [today-lookback, today-grace]
  graceDays: number; // skip the trailing `grace` days (still settling)
  expectedPointTails: readonly string[]; // the coverage set gap-detection scans
  needsCredentials: boolean; // Amber/Sigen true (per-owner Clerk creds); OE false (global key)
  hasDerivedFlow: boolean; // does the vendor feed area flow/provenance (doc hint; area lookup is the real guard)

  /** Local-day bucket offset (minutes east of UTC): fixed 600 for Amber/OE (NEM AEST, no DST),
   *  station-local `system.timezoneOffsetMin` for Sigenergy. Must match the vendor's write path. */
  bucketOffsetMin(system: DeviceConfigView): number;

  /** Load credentials / build a client for a real backfill. Returns an error string if it can't run.
   *  Never called in dry-run. Keeps credential POLICY here so vendor primitives always get real creds. */
  prepare(system: DeviceConfigView): Promise<PrepareResult<Ctx>>;

  /** Backfill ONE local gap-day: re-fetch + publish via the shared collector. Maps the vendor's native
   *  result → repaired (published rows) | unsettled (API had nothing) | error. */
  backfillDay(
    system: DeviceConfigView,
    day: string,
    ctx: Ctx,
    session: SessionInfo,
    collector: PollCollector,
  ): Promise<DayRepair>;

  /** Optional: the vendor-reported commissioning / "birth" day (station-local, "YYYY-MM-DD") for this
   *  system — the earliest date data could exist. Best-effort (may hit the vendor API). The runner uses
   *  it to floor the repair window (so pre-commission days aren't flagged as phantom gaps, and genuine
   *  pre-onboarding history stays in range) and to lazily populate `systems.commissioned_on`. Returns
   *  null if unknown/unavailable. Implement only where the vendor exposes such a date. */
  commissionDay?(system: DeviceConfigView): Promise<string | null>;
}
