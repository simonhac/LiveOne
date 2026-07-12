/**
 * Period-report reads over the attribution rollup (`point_readings_flow_attr_1d`) — the "what did it cost
 * / how green / what emissions to <load> over <range>" questions, as one GROUP BY. Averages use FILTERED
 * denominators (energy whose intensity was known) so an unknown-intensity edge/day never biases them; the
 * confidence rides along as `pctEstimated`.
 */
import { sql } from "drizzle-orm";
import { requirePlanetscaleDb } from "@/lib/db/planetscale";

export interface LoadProvenanceSummary {
  loadPath: string;
  energyKwh: number;
  /** Total attributed cost over the range (dollars; over priced energy). */
  costDollars: number;
  /** Unbiased average price over energy whose price was known (c/kWh). */
  avgCentsPerKwh: number | null;
  /** % renewable over energy whose renewable fraction was known. */
  pctRenewable: number | null;
  /** Unbiased average emissions over energy whose intensity was known (gCO2/kWh). */
  avgGramsPerKwh: number | null;
  /** Total attributed emissions (kg CO2). */
  kgCo2: number;
  /** % of the load's energy whose attribution used an estimated/unknown intensity (confidence). */
  pctEstimated: number;
}

/** Per (load, source) energy split — e.g. how much of the EV came from grid vs battery vs solar. */
export interface SourceContribution {
  loadPath: string;
  sourcePath: string;
  energyKwh: number;
}

export interface ProvenanceSummary {
  loads: LoadProvenanceSummary[];
  sources: SourceContribution[];
}

/**
 * Summarise the attribution rollup for one Area over [startDay, endDay] (inclusive, `YYYY-MM-DD`). One
 * row per load, plus the per-(load,source) energy split. Empty when the Area has no materialised rollup.
 */
export async function getProvenanceSummary(
  areaId: string,
  startDay: string,
  endDay: string,
): Promise<ProvenanceSummary> {
  const db = requirePlanetscaleDb();

  const loadRows: any = await db.execute(sql`
    select
      load_path,
      sum(energy_kwh)                                                          as energy_kwh,
      coalesce(sum(cost_c), 0) / 100.0                                         as cost_dollars,
      sum(cost_c)      / nullif(sum(energy_kwh) filter (where cost_c is not null), 0)      as avg_c_per_kwh,
      100 * sum(renewable_kwh) / nullif(sum(energy_kwh) filter (where renewable_kwh is not null), 0) as pct_renewable,
      sum(emissions_g) / nullif(sum(energy_kwh) filter (where emissions_g is not null), 0) as avg_g_per_kwh,
      coalesce(sum(emissions_g), 0) / 1000.0                                   as kg_co2,
      100 * sum(estimated_kwh) / nullif(sum(energy_kwh), 0)                    as pct_estimated
    from point_readings_flow_attr_1d
    where area_id = ${areaId} and day between ${startDay} and ${endDay}
    group by load_path
    order by load_path
  `);

  const sourceRows: any = await db.execute(sql`
    select load_path, source_path, sum(energy_kwh) as energy_kwh
    from point_readings_flow_attr_1d
    where area_id = ${areaId} and day between ${startDay} and ${endDay}
    group by load_path, source_path
    order by load_path, source_path
  `);

  const num = (v: unknown): number => (v == null ? 0 : Number(v));
  const numOrNull = (v: unknown): number | null =>
    v == null ? null : Number(v);

  const loads: LoadProvenanceSummary[] = (
    (loadRows.rows ?? loadRows) as any[]
  ).map((r) => ({
    loadPath: r.load_path,
    energyKwh: num(r.energy_kwh),
    costDollars: num(r.cost_dollars),
    avgCentsPerKwh: numOrNull(r.avg_c_per_kwh),
    pctRenewable: numOrNull(r.pct_renewable),
    avgGramsPerKwh: numOrNull(r.avg_g_per_kwh),
    kgCo2: num(r.kg_co2),
    pctEstimated: num(r.pct_estimated),
  }));
  const sources: SourceContribution[] = (
    (sourceRows.rows ?? sourceRows) as any[]
  ).map((r) => ({
    loadPath: r.load_path,
    sourcePath: r.source_path,
    energyKwh: num(r.energy_kwh),
  }));

  return { loads, sources };
}
