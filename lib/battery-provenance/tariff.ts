/**
 * Export (feed-in) tariff resolution — pure, NO IO. Turns an area's `ExportTariffConfig` into the single
 * per-interval `exportPrice[]` series (c/kWh feed-in) that the battery-provenance fold consumes for SOLAR
 * OPPORTUNITY COST. The fold never sees modes/schedules/bands — only this series — so a future persisted
 * "tariff device" (Option B) is a drop-in: it would materialise the SAME schedule (via `ScheduleTariffProvider`,
 * reused by that writer) into a `bidi.grid.export/rate` point the loader reads exactly like Amber, with no
 * fold change. See `lib/capabilities/config.ts` for the schema and docs/architecture/battery-provenance.md.
 *
 * Local time uses the Area's FIXED standard offset (`tzOffsetMin`), matching how the rest of the engine
 * derives local-day boundaries (see `battery-provenance-pg.ts` localDaysInRange) — DST-stable by design.
 */
import type {
  ExportTariffConfig,
  ExportTariffPlan,
  ExportTariffRate,
} from "@/lib/capabilities/config";

/** A source of the feed-in price at an interval end. `null` = no export tariff (opportunity == actual). */
export interface TariffProvider {
  /** Feed-in price (c/kWh) applicable at `intervalEndMs` (epoch ms). null = no tariff at that time. */
  exportPriceAt(intervalEndMs: number): number | null;
}

/** Constant no-tariff provider (mode "none", or a schedule that predates its earliest plan). */
export const NO_TARIFF: TariffProvider = { exportPriceAt: () => null };

/** Local calendar fields for an epoch-ms at a fixed standard offset (UTC getters on the shifted instant). */
function localFields(ms: number, tzOffsetMin: number) {
  const d = new Date(ms + tzOffsetMin * 60000);
  return {
    ymd: d.toISOString().slice(0, 10), // "YYYY-MM-DD" (ISO dates sort lexically)
    minutesOfDay: d.getUTCHours() * 60 + d.getUTCMinutes(),
    dayOfWeek: d.getUTCDay(), // 0=Sun … 6=Sat
    month: d.getUTCMonth() + 1, // 1 … 12
  };
}

/**
 * A retailer-schedule provider: selects the effective plan for the interval's local date (newest
 * `effectiveFrom` ≤ date wins; before the earliest plan ⇒ null) then evaluates its rate. Pure & reusable —
 * the future tariff-device writer (Option B) will call this same class to materialise the export-rate point.
 */
export class ScheduleTariffProvider implements TariffProvider {
  private readonly plans: ExportTariffPlan[];

  constructor(
    plans: ExportTariffPlan[],
    private readonly tzOffsetMin: number,
  ) {
    // Ascending by effectiveFrom; a missing effectiveFrom is "always" (sorts earliest).
    this.plans = [...plans].sort((a, b) =>
      (a.effectiveFrom ?? "").localeCompare(b.effectiveFrom ?? ""),
    );
  }

  exportPriceAt(intervalEndMs: number): number | null {
    const f = localFields(intervalEndMs, this.tzOffsetMin);
    const plan = this.pickPlan(f.ymd);
    if (!plan) return null;
    return evalRate(plan.rate, intervalEndMs, this.tzOffsetMin);
  }

  /** Newest plan whose `effectiveFrom` ≤ the local date (missing effectiveFrom = always). */
  private pickPlan(localYmd: string): ExportTariffPlan | null {
    let chosen: ExportTariffPlan | null = null;
    for (const p of this.plans) {
      if (p.effectiveFrom === undefined || p.effectiveFrom <= localYmd)
        chosen = p;
      else break; // sorted ascending — the rest are in the future
    }
    return chosen;
  }
}

/** Evaluate a rate at an instant. `flat` is built now; `tou` is schema-reserved (evaluator lands later). */
function evalRate(
  rate: ExportTariffRate,
  intervalEndMs: number,
  tzOffsetMin: number,
): number | null {
  if (rate.kind === "flat") return rate.cPerKwh;
  // rate.kind === "tou" — reserved for the TOU/tariff-device work; not evaluated yet.
  void intervalEndMs;
  void tzOffsetMin;
  throw new Error(
    "TOU export tariffs are not implemented yet (schema reserved for the TOU / tariff-device work)",
  );
}

/**
 * Resolve the per-interval feed-in price series (c/kWh) the fold consumes, aligned to `timeline`.
 *   - undefined | { mode: "none" } → all null (no opportunity cost).
 *   - { mode: "amber" }            → the measured `bidi.grid.export/rate` series (loader-supplied).
 *   - { mode: "schedule", plans }  → synthesised on-the-fly from the effective-dated schedule.
 * `amberExportPrice` is the measured series the loader already reads (used only for mode "amber").
 */
export function resolveExportPriceSeries(
  cfg: ExportTariffConfig | undefined,
  timeline: number[],
  tzOffsetMin: number,
  amberExportPrice: (number | null)[],
): (number | null)[] {
  if (!cfg || cfg.mode === "none") return timeline.map(() => null);
  if (cfg.mode === "amber") return amberExportPrice;
  const provider = new ScheduleTariffProvider(cfg.plans, tzOffsetMin);
  return timeline.map((ms) => provider.exportPriceAt(ms));
}
