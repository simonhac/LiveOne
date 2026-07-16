/**
 * Sigenergy coverage-repair provider (Stage-2 backfill adapter).
 *
 * Sigenergy is 5-min-native ENERGY (differenced cumulative counters), STATION-LOCAL dates, with
 * per-owner Clerk credentials. Backfill re-fetches one local day via `backfillEnergyRange` (start=end),
 * publishing through the shared collector → receiver → agg_5m path.
 */
import { backfillEnergyRange } from "@/lib/vendors/sigenergy/statistics";
import { SigenergyClient } from "@/lib/vendors/sigenergy/sigenergy-client";
import { getSystemCredentials } from "@/lib/secure-credentials";
import type { CoverageRepairProvider, DayRepair } from "@/lib/coverage/types";

interface SigenCtx {
  client: SigenergyClient;
  stationId: string;
}

/** The six 5-min interval-energy points (Wh) written by the statistics backfill. */
const SIGEN_ENERGY_TAILS = [
  "solar_interval_wh",
  "load_interval_wh",
  "grid_import_interval_wh",
  "grid_export_interval_wh",
  "battery_charge_interval_wh",
  "battery_discharge_interval_wh",
] as const;

export const sigenergyProvider: CoverageRepairProvider<SigenCtx> = {
  vendorType: "sigenergy",
  cadenceMinutes: 5, // 288/day
  lookbackDays: 90,
  graceDays: 7,
  expectedPointTails: SIGEN_ENERGY_TAILS,
  needsCredentials: true,
  hasDerivedFlow: true,
  bucketOffsetMin: (s) => s.timezoneOffsetMin ?? 600, // station-local
  async prepare(system) {
    if (!system.ownerClerkUserId)
      return { ok: false, error: "no owner (Sigenergy credentials required)" };
    if (!system.vendorSiteId)
      return { ok: false, error: "no Sigenergy station id (vendorSiteId)" };
    const base = await getSystemCredentials(system.ownerClerkUserId, system.id);
    if (!base?.username || !base?.password)
      return { ok: false, error: "no Sigenergy credentials" };
    const client = new SigenergyClient({
      username: base.username,
      password: base.password,
      region: base.region ?? "aus",
    });
    return { ok: true, ctx: { client, stationId: system.vendorSiteId } };
  },
  async backfillDay(system, day, ctx, session, collector): Promise<DayRepair> {
    const ymd = day.replace(/-/g, ""); // 'YYYY-MM-DD' → 'YYYYMMDD'
    const tz = system.timezoneOffsetMin ?? 600;
    try {
      const res = await backfillEnergyRange({
        client: ctx.client,
        systemId: system.id,
        stationId: ctx.stationId,
        startDate: ymd,
        endDate: ymd,
        tzOffsetMin: tz,
        session,
        collector,
      });
      const rows = res.days?.[0]?.readingsWritten ?? 0;
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
