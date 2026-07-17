/**
 * OpenElectricity coverage-repair provider (Stage-2 backfill adapter).
 *
 * OE is 5-min-native NEM grid data (AEST, fixed +10) with an OWNERLESS global API key
 * (OPEN_ELECTRICITY_API_KEY) — one system per region (vendorSiteId = NSW1/VIC1/…). Backfill re-fetches
 * a day via `backfillRange` (which publishes through the shared collector → receiver → agg_5m path).
 *
 * DETECTION covers all four points, incl. `nem/emissionsIntensity` (derived = emissions÷energy). An
 * earlier version excluded it, assuming the mapper's `emissions<=0` / `power<=0` skips made it sparse
 * "by design" — but those never fire for a whole NEM region (aggregate power is always thousands of MW,
 * emissions always hundreds of tCO2). Empirically it is ~288/day (NSW1: short on 6/329 days, comparable
 * to price/renewables/demand), and its short days are the SAME recoverable data-endpoint publish-lag
 * holes we want to heal — the `data` leg publishes later than `market`, so a just-closed interval's
 * emissions can miss the live poll's re-pull window while price/renewables/demand already landed.
 * Backfill re-fetches + re-derives all four points; the runner's progress-based landing keeps the one
 * theoretical edge case (a genuinely zero-emissions region interval) harmless — it just stays
 * `unsettled`, never a false "repaired-forever" loop.
 */
import { backfillRange } from "@/lib/vendors/openelectricity/backfill";
import { isNemRegion } from "@/lib/vendors/openelectricity/types";
import type { CoverageRepairProvider, DayRepair } from "@/lib/coverage/types";

const AEST_OFFSET_MS = 600 * 60_000; // NEM fixed UTC+10
const DAY_MS = 86400 * 1000;

export const openelectricityProvider: CoverageRepairProvider<
  Record<string, never>
> = {
  vendorType: "openelectricity",
  cadenceMinutes: 5, // 288/day
  lookbackDays: 90,
  graceDays: 7,
  expectedPointTails: [
    "nem/price",
    "nem/renewableProportion",
    "nem/demand",
    "nem/emissionsIntensity",
  ],
  needsCredentials: false, // single global OPEN_ELECTRICITY_API_KEY, ownerless
  hasDerivedFlow: false, // region grid data feeds no household area
  bucketOffsetMin: () => 600,
  async prepare() {
    if (!process.env.OPEN_ELECTRICITY_API_KEY)
      return { ok: false, error: "OPEN_ELECTRICITY_API_KEY not set" };
    return { ok: true, ctx: {} };
  },
  async backfillDay(system, day, _ctx, session, collector): Promise<DayRepair> {
    const region = system.vendorSiteId;
    if (!region || !isNemRegion(region))
      return {
        systemId: system.id,
        day,
        publishedRows: 0,
        status: "error",
        error: `not a NEM region: ${region}`,
      };
    try {
      const startMs = Date.parse(`${day}T00:00:00Z`) - AEST_OFFSET_MS; // AEST midnight of `day`
      const res = await backfillRange({
        systemId: system.id,
        region,
        dateStart: new Date(startMs),
        dateEnd: new Date(startMs + DAY_MS),
        session,
        collector,
        aggregate: null, // runner owns the scoped recompute, never the all-systems cascade
      });
      const rows = res.intervalsIngested ?? 0;
      if (res.errors && res.errors.length > 0)
        return {
          systemId: system.id,
          day,
          publishedRows: rows,
          status: "error",
          error: res.errors.join("; "),
        };
      return {
        systemId: system.id,
        day,
        publishedRows: rows,
        status: rows > 0 ? "repaired" : "unsettled",
      };
    } catch (err) {
      return {
        systemId: system.id,
        day,
        publishedRows: 0,
        status: "error",
        error: err instanceof Error ? err.message : String(err),
      };
    }
  },
};
