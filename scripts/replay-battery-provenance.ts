#!/usr/bin/env tsx
/**
 * OFFLINE replay of the battery-provenance fold + metric attribution over REAL history.
 *
 * Phase-1 validation harness (see docs plan): it reads the battery / solar / grid / load `agg_5m`
 * for an Area, plus the OpenElectricity region's emissions+renewables and Amber's import/export
 * price, runs the pure `foldBatteryProvenance` + `computeFlowAttribution`, and PRINTS:
 *   - a sampled battery-intensity series (what the 3 derived points would hold),
 *   - a worked EV-charging attribution over the window (cost / %renewable / avg emissions),
 *   - the estimated-fraction (confidence) and a data-coverage summary.
 *
 * STRICTLY READ-ONLY + DRY-RUN — it never writes a row. The DB target is whatever `.env.local`
 * points at; prod (sydney) has NO stored connection string (it must be minted on demand), so a
 * stored URL is `liveone-dev`, the prod mirror. The connected identity is printed up front.
 *
 * Usage:
 *   npx tsx scripts/replay-battery-provenance.ts --discover           # list candidate Areas
 *   npx tsx scripts/replay-battery-provenance.ts --system=<handle> --days=3
 *   npx tsx scripts/replay-battery-provenance.ts --system=<handle> --start=2026-07-05 --end=2026-07-12 \
 *        --floor=10 --solar=zero
 */
import * as dotenv from "dotenv";
dotenv.config({ path: ".env.local" });

// The replay is read-only; alias the stored (liveone-dev) migrations URL to the runtime var the app
// reads, so `planetscaleDb` connects. Never do this in app code — this is a workstation-only replay.
if (
  !process.env.PLANETSCALE_DATABASE_URL &&
  process.env.PLANETSCALE_DATABASE_URL_MIGRATIONS
) {
  process.env.PLANETSCALE_DATABASE_URL =
    process.env.PLANETSCALE_DATABASE_URL_MIGRATIONS;
}

import { and, eq, gte, lte, or, asc, sql } from "drizzle-orm";
import { planetscaleDb } from "../lib/db/planetscale";
import {
  pointInfo,
  pointReadingsAgg5m,
  areas,
  areaBindings,
  systems,
} from "../lib/db/planetscale/schema";
import { applyPowerTransform } from "../lib/aggregation/flow-series";
import {
  buildFlowSeries,
  ClassifiedPoint,
} from "../lib/aggregation/flow-series";
import {
  computeFlowMatrix,
  FlowSeries,
} from "../lib/aggregation/flow-matrix-core";
import { extractBatteryFlows } from "../lib/battery-provenance/battery-flows";
import {
  foldBatteryProvenance,
  FoldInterval,
  FoldConfig,
} from "../lib/battery-provenance/fold";
import {
  computeFlowAttribution,
  SourceIntensity,
} from "../lib/aggregation/flow-attribution-core";
import { nemRegionForLocation } from "../lib/vendors/openelectricity/region";
import type { AreaLocation } from "../lib/areas/types";

const FIVE_MIN_MS = 5 * 60 * 1000;

// ---- arg parsing --------------------------------------------------------
const argOf = (name: string) =>
  process.argv.find((a) => a.startsWith(`--${name}=`))?.split("=")[1];
const DISCOVER = process.argv.includes("--discover");
const SYSTEM = argOf("system") ? Number(argOf("system")) : null;
const DAYS = argOf("days") ? Number(argOf("days")) : 3;
const START = argOf("start");
const END = argOf("end");
const FLOOR = argOf("floor") ? Number(argOf("floor")) : 10;
const SOLAR_VALUATION = (argOf("solar") ?? "zero") as "zero" | "opportunity";
// Ablation switch: pretend SoC is unavailable, to measure how much it matters (the fold then relies
// on full-discharge auto-resets instead of the SoC floor).
const NO_SOC = process.argv.includes("--no-soc");

function db() {
  if (!planetscaleDb) {
    throw new Error(
      "No Postgres connection (set PLANETSCALE_DATABASE_URL or PLANETSCALE_DATABASE_URL_MIGRATIONS in .env.local).",
    );
  }
  return planetscaleDb;
}

/** g/kWh from OE's tCO2e/MWh (1 tCO2e/MWh = 1000 g/kWh). */
const oeEmissionsToGPerKwh = (v: number | null) =>
  v === null ? null : v * 1000;
/** kW from an aggregate value given its unit (W/Wh → /1000). */
const toKw = (v: number | null, unit: string | null) =>
  v === null ? null : unit === "W" || unit === "Wh" ? v / 1000 : v;

interface SeriesPoint {
  t: number;
  v: number | null;
  dq: string | null;
}

async function readAgg5m(
  systemId: number,
  pointId: number,
  startMs: number,
  endMs: number,
): Promise<SeriesPoint[]> {
  const rows = await db()
    .select({
      t: pointReadingsAgg5m.intervalEnd,
      v: pointReadingsAgg5m.avg,
      dq: pointReadingsAgg5m.dataQuality,
    })
    .from(pointReadingsAgg5m)
    .where(
      and(
        eq(pointReadingsAgg5m.systemId, systemId),
        eq(pointReadingsAgg5m.pointId, pointId),
        gte(pointReadingsAgg5m.intervalEnd, new Date(startMs)),
        lte(pointReadingsAgg5m.intervalEnd, new Date(endMs)),
      ),
    )
    .orderBy(asc(pointReadingsAgg5m.intervalEnd));
  return rows.map((r) => ({ t: r.t.getTime(), v: r.v, dq: r.dq }));
}

/**
 * Forward-fill a source series onto a target timeline: each target t takes the latest source value
 * at time ≤ t within `maxStaleMs`, else null. Handles OE's exact 5-min match, its gaps, and Amber's
 * 30-min step. Returns aligned values + whether each was forward-filled (staler than one interval)
 * or carried a non-good data_quality (→ "estimated" for the fold).
 */
function forwardFill(
  timeline: number[],
  src: SeriesPoint[],
  maxStaleMs: number,
): { value: (number | null)[]; estimated: boolean[] } {
  const value = new Array<number | null>(timeline.length).fill(null);
  const estimated = new Array<boolean>(timeline.length).fill(false);
  let j = 0;
  let last: SeriesPoint | null = null;
  for (let i = 0; i < timeline.length; i++) {
    const t = timeline[i];
    while (j < src.length && src[j].t <= t) last = src[j++];
    if (last && t - last.t <= maxStaleMs) {
      value[i] = last.v;
      const filled = t - last.t > FIVE_MIN_MS;
      estimated[i] = filled || (last.dq != null && last.dq !== "good");
    } else {
      value[i] = null;
      estimated[i] = true;
    }
  }
  return { value, estimated };
}

interface BoundPoint {
  systemId: number;
  pointId: number;
  role: string;
  metric: string;
  stem: string | null;
  unit: string | null;
  transform: string | null;
}

/**
 * The Area's CURATED points via `area_bindings` (joined to point_info for stem/unit/transform) —
 * the same selection the real logical-system resolver uses. This dedupes overlapping devices (e.g.
 * a site with both Fronius and Mondo measuring battery/grid): the binding picks exactly one point
 * per role/metric, so `buildFlowSeries` isn't fed conflicting series.
 */
async function boundPoints(areaId: string): Promise<BoundPoint[]> {
  const rows = await db()
    .select({
      systemId: areaBindings.pointSystemId,
      pointId: areaBindings.pointId,
      role: areaBindings.role,
      metric: areaBindings.metricType,
      stem: pointInfo.logicalPathStem,
      unit: pointInfo.metricUnit,
      transform: areaBindings.transform,
      piTransform: pointInfo.transform,
    })
    .from(areaBindings)
    .innerJoin(
      pointInfo,
      and(
        eq(pointInfo.systemId, areaBindings.pointSystemId),
        eq(pointInfo.index, areaBindings.pointId),
      ),
    )
    .where(eq(areaBindings.areaId, areaId));
  return rows.map((r) => ({
    systemId: r.systemId,
    pointId: r.pointId,
    role: r.role,
    metric: r.metric,
    stem: r.stem,
    unit: r.unit,
    transform: r.transform ?? r.piTransform, // per-binding override, else inherit point_info
  }));
}

async function runDiscover() {
  const rows = await db()
    .select({
      systemId: pointInfo.systemId,
      stem: pointInfo.logicalPathStem,
      metric: pointInfo.metricType,
    })
    .from(pointInfo)
    .where(
      or(
        and(
          eq(pointInfo.logicalPathStem, "bidi.battery"),
          eq(pointInfo.metricType, "soc"),
        ),
        eq(pointInfo.logicalPathStem, "load.ev"),
        and(
          eq(pointInfo.logicalPathStem, "bidi.grid.import"),
          eq(pointInfo.metricType, "rate"),
        ),
      ),
    );
  const bySystem = new Map<number, Set<string>>();
  for (const r of rows) {
    const key = `${r.stem}/${r.metric}`;
    if (!bySystem.has(r.systemId)) bySystem.set(r.systemId, new Set());
    bySystem.get(r.systemId)!.add(key);
  }
  const areaRows = await db()
    .select({
      id: areas.id,
      handle: areas.legacySystemId,
      name: areas.displayName,
    })
    .from(areas);
  console.log(
    "\nCandidate systems (have battery SoC / EV load / Amber price):",
  );
  for (const [systemId, feats] of bySystem) {
    console.log(`  system ${systemId}: ${[...feats].sort().join(", ")}`);
  }
  console.log("\nAreas (handle = --system):");
  for (const a of areaRows) {
    console.log(`  handle ${a.handle}  area ${a.id}  "${a.name ?? ""}"`);
  }
}

async function runReplay(handle: number) {
  const nowMs = Date.now();
  const startMs = START
    ? Date.parse(`${START}T00:00:00Z`)
    : nowMs - DAYS * 24 * 3600 * 1000;
  const endMs = END ? Date.parse(`${END}T23:59:59Z`) : nowMs;

  const [area] = await db()
    .select({
      id: areas.id,
      tz: areas.timezoneOffsetMin,
      location: areas.location,
    })
    .from(areas)
    .where(eq(areas.legacySystemId, handle))
    .limit(1);
  if (!area) throw new Error(`No area with legacy_system_id=${handle}`);

  const bound = await boundPoints(area.id);

  // Curated typed POWER points (bindings) → the flow-series inputs (one point per role, deduped).
  const powerPoints = bound.filter((b) => b.metric === "power" && b.stem);

  // Read each power point's agg_5m and build a dense shared timeline.
  const perPoint = await Promise.all(
    powerPoints.map(async (p) => ({
      p,
      series: await readAgg5m(p.systemId, p.pointId, startMs, endMs),
    })),
  );
  const tset = new Set<number>();
  for (const { series } of perPoint) for (const s of series) tset.add(s.t);
  const timeline = [...tset].sort((a, b) => a - b);
  if (timeline.length < 2) {
    console.log("Not enough 5m data in the window — widen --days/--start.");
    return;
  }
  const tIndex = new Map(timeline.map((t, i) => [t, i]));

  const classified: ClassifiedPoint[] = perPoint.map(({ p, series }) => {
    const power = new Array<number | null>(timeline.length).fill(null);
    for (const s of series) {
      const i = tIndex.get(s.t);
      if (i !== undefined)
        power[i] = applyPowerTransform(toKw(s.v, p.unit), p.transform);
    }
    return { stem: p.stem!, power };
  });

  const { sources, loads } = buildFlowSeries(classified);
  if (sources.length === 0 || loads.length === 0) {
    console.log("No complete source/load set for this Area.");
    return;
  }

  // Battery SoC (bound role=battery/metric=soc) — OPTIONAL. Missing → SoC-blind operation (see fold).
  const socBind = bound.find((b) => b.role === "battery" && b.metric === "soc");
  const socSeries = socBind
    ? await readAgg5m(socBind.systemId, socBind.pointId, startMs, endMs)
    : [];
  const soc = NO_SOC
    ? new Array<number | null>(timeline.length).fill(null)
    : forwardFill(timeline, socSeries, 30 * 60 * 1000).value;
  const socCoverage =
    soc.filter((v) => v !== null).length / Math.max(soc.length, 1);

  // Reserve floor = a LOW PERCENTILE of SoC over a LONG window (90 days), NOT a daily minimum — robust
  // to weeks without a full cycle. Read a wider SoC history just for this estimate.
  let estReserve = FLOOR;
  if (socBind && !NO_SOC) {
    const longStart = endMs - 90 * 24 * 3600 * 1000;
    const longSoc = await readAgg5m(
      socBind.systemId,
      socBind.pointId,
      longStart,
      endMs,
    );
    const vals = longSoc
      .map((s) => s.v)
      .filter((v): v is number => v !== null)
      .sort((a, b) => a - b);
    if (vals.length > 20) {
      estReserve = vals[Math.floor(0.02 * vals.length)]; // ~2nd percentile
    }
  }
  const reserveFloorPct = argOf("floor") ? FLOOR : estReserve;

  // OE region emissions + renewables — resolved DIRECTLY from the Area's location (the grid-role
  // check in resolveGridContextForSystem fails for a virtual multi-device area handle).
  const region = nemRegionForLocation(
    (area.location ?? null) as AreaLocation | null,
  );
  let gridEI = new Array<number | null>(timeline.length).fill(null);
  let gridEIest = new Array<boolean>(timeline.length).fill(true);
  let gridRenew = new Array<number | null>(timeline.length).fill(null);
  if (region) {
    const [oeSys] = await db()
      .select({ id: systems.id })
      .from(systems)
      .where(
        and(
          eq(systems.vendorType, "openelectricity"),
          eq(systems.vendorSiteId, region),
        ),
      )
      .limit(1);
    if (oeSys) {
      const oePts = await db()
        .select({ pointId: pointInfo.index, stem: pointInfo.logicalPathStem })
        .from(pointInfo)
        .where(
          and(
            eq(pointInfo.systemId, oeSys.id),
            or(
              eq(pointInfo.logicalPathStem, "grid.emissionsIntensity"),
              eq(pointInfo.logicalPathStem, "grid.renewables"),
            ),
          ),
        );
      for (const op of oePts) {
        const s = await readAgg5m(oeSys.id, op.pointId, startMs, endMs);
        const ff = forwardFill(timeline, s, 15 * 60 * 1000);
        if (op.stem === "grid.emissionsIntensity") {
          gridEI = ff.value.map(oeEmissionsToGPerKwh);
          gridEIest = ff.estimated;
        } else {
          gridRenew = ff.value.map((v) => (v === null ? null : v / 100));
        }
      }
    }
  }

  // Amber import price (bound grid/rate → bidi.grid.import) + export/feed-in (for opportunity solar).
  const rateBinds = bound.filter(
    (b) => b.role === "grid" && b.metric === "rate",
  );
  let importPrice = new Array<number | null>(timeline.length).fill(null);
  let importEst = new Array<boolean>(timeline.length).fill(true);
  let exportPrice = new Array<number | null>(timeline.length).fill(null);
  for (const rp of rateBinds) {
    if (rp.stem !== "bidi.grid.import" && rp.stem !== "bidi.grid.export")
      continue;
    const s = await readAgg5m(rp.systemId, rp.pointId, startMs, endMs);
    const ff = forwardFill(timeline, s, 35 * 60 * 1000);
    if (rp.stem === "bidi.grid.import") {
      importPrice = ff.value;
      importEst = ff.estimated;
    } else {
      exportPrice = ff.value;
    }
  }
  const priceCoverage =
    importPrice.filter((v) => v !== null).length /
    Math.max(importPrice.length, 1);
  const eiCoverage =
    gridEI.filter((v) => v !== null).length / Math.max(gridEI.length, 1);

  // ---- assemble fold intervals + run the fold ----
  const bflows = extractBatteryFlows(timeline, sources, loads);

  // Learned round-trip efficiency η = Σout/Σin over the window (SoC-free). Clamped to a sane band;
  // a real deployment would use a rolling/EWMA estimate. --eta=N overrides.
  let sumIn = 0;
  let sumOut = 0;
  for (const bf of bflows) {
    sumIn += bf.solarChargeKwh + bf.gridChargeKwh + bf.otherChargeKwh;
    sumOut += bf.dischargeKwh;
  }
  const measuredEta = sumIn > 0 ? sumOut / sumIn : 1;
  const etaArg = argOf("eta");
  const eta = etaArg ? Number(etaArg) : Math.min(1, Math.max(0.7, measuredEta));

  const config: FoldConfig = {
    reserveFloorPct,
    efficiency: eta,
    maxSegmentIntervals: 6 * 288, // 6-day staleness backstop
    reanchorEpsKwh: 0.3, // clean tiny residual left by η mis-estimate
  };
  const intervals: FoldInterval[] = bflows.map((bf, i) => ({
    solarChargeKwh: bf.solarChargeKwh,
    gridChargeKwh: bf.gridChargeKwh,
    otherChargeKwh: bf.otherChargeKwh,
    dischargeKwh: bf.dischargeKwh,
    gridEmissionsIntensity: gridEI[i],
    gridRenewableFraction: gridRenew[i],
    gridPrice: importPrice[i],
    solarCost:
      SOLAR_VALUATION === "opportunity" ? Math.max(0, exportPrice[i] ?? 0) : 0,
    socPct: soc[i],
    gridEstimated: gridEIest[i] || importEst[i],
  }));
  const { steps, finalState } = foldBatteryProvenance(intervals, config);

  // ---- attribution: build per-source intensity, run computeFlowAttribution ----
  const solarCostSeries = timeline.map((_, i) =>
    SOLAR_VALUATION === "opportunity" ? Math.max(0, exportPrice[i] ?? 0) : 0,
  );
  const sourceIntensities: (SourceIntensity | null)[] = sources.map((src) => {
    if (src.path === "source.solar" || src.path.startsWith("source.solar.")) {
      return {
        emissions: timeline.map(() => 0),
        renewable: timeline.map(() => 1),
        price: solarCostSeries,
        estimated: timeline.map(() => false),
      };
    }
    if (src.path === "source.grid") {
      return {
        emissions: gridEI,
        renewable: gridRenew,
        price: importPrice,
        estimated: timeline.map((_, i) => gridEIest[i] || importEst[i]),
      };
    }
    if (src.path === "source.battery") {
      const emissions = new Array<number | null>(timeline.length).fill(null);
      const renewable = new Array<number | null>(timeline.length).fill(null);
      const price = new Array<number | null>(timeline.length).fill(null);
      const estimated = new Array<boolean>(timeline.length).fill(false);
      for (let i = 0; i < steps.length; i++) {
        emissions[i] = steps[i].batteryEmissionsIntensity;
        renewable[i] = steps[i].batteryRenewableFraction;
        price[i] = steps[i].batteryPrice;
        estimated[i] = steps[i].estimatedFraction > 0;
      }
      return { emissions, renewable, price, estimated };
    }
    return null; // e.g. source.generator — unknown intensity
  });

  const attr = computeFlowAttribution({
    timestamps: timeline,
    sources,
    loads,
    sourceIntensities,
  });
  const energy = computeFlowMatrix({ timestamps: timeline, sources, loads });

  // ================= REPORT =================
  const fmtT = (ms: number) =>
    new Date(ms).toISOString().slice(0, 16).replace("T", " ");
  console.log(
    `\n=== Battery-provenance replay: handle ${handle}, area ${area.id} ===`,
  );
  console.log(
    `window ${fmtT(timeline[0])} .. ${fmtT(timeline[timeline.length - 1])} UTC  (${timeline.length} intervals)`,
  );
  console.log(
    `reserve=${reserveFloorPct.toFixed(0)}%  η=${(100 * eta).toFixed(1)}%${etaArg ? "(set)" : "(learned)"}  ` +
      `solar=${SOLAR_VALUATION}  region=${region ?? "none"}`,
  );
  console.log(
    `input coverage:  SoC ${(100 * socCoverage).toFixed(0)}%   ` +
      `emissions ${(100 * eiCoverage).toFixed(0)}%   price ${(100 * priceCoverage).toFixed(0)}%\n`,
  );

  console.log("Battery blend (sampled every ~2h):");
  console.log(
    "  time (UTC)        SoC%   E(kWh)   g/kWh   %renew   c/kWh   est%",
  );
  for (let i = 0; i < steps.length; i += 24) {
    const s = steps[i];
    const row = [
      fmtT(timeline[i]).padEnd(17),
      (soc[i] ?? NaN).toFixed(0).padStart(4),
      s.storedKwh.toFixed(2).padStart(7),
      (s.batteryEmissionsIntensity ?? NaN).toFixed(0).padStart(6),
      s.batteryRenewableFraction == null
        ? "   -- "
        : (s.batteryRenewableFraction * 100).toFixed(0).padStart(6),
      (s.batteryPrice ?? NaN).toFixed(1).padStart(6),
      (s.estimatedFraction * 100).toFixed(0).padStart(5),
    ].join(" ");
    console.log("  " + row);
  }

  // Per-load attribution table.
  const loadIdx = (p: string) => attr.loads.indexOf(p);
  const sumCol = (m: number[][], l: number) =>
    m.reduce((acc, row) => acc + row[l], 0);
  console.log("\nPer-load attribution over window:");
  console.log(
    "  load                  kWh     $cost   avg c/kWh   %renew   avg g/kWh   %est",
  );
  for (let l = 0; l < attr.loads.length; l++) {
    const kwh = sumCol(attr.energyKwh, l);
    if (kwh < 0.05) continue;
    const g = sumCol(attr.emissionsG, l);
    const gKwh = sumCol(attr.emissionsKnownKwh, l);
    const rkwh = sumCol(attr.renewableKwh, l);
    const rKwh = sumCol(attr.renewableKnownKwh, l);
    const c = sumCol(attr.costC, l);
    const cKwh = sumCol(attr.priceKnownKwh, l);
    const estKwh = sumCol(attr.estimatedKwh, l);
    const row = [
      attr.loads[l].padEnd(20),
      kwh.toFixed(1).padStart(7),
      (c / 100).toFixed(2).padStart(8),
      cKwh > 0 ? (c / cKwh).toFixed(1).padStart(9) : "     -- ",
      rKwh > 0 ? ((100 * rkwh) / rKwh).toFixed(0).padStart(7) : "    -- ",
      gKwh > 0 ? (g / gKwh).toFixed(0).padStart(10) : "       -- ",
      ((100 * estKwh) / Math.max(kwh, 1e-9)).toFixed(0).padStart(5),
    ].join(" ");
    console.log("  " + row);
  }

  // EV headline + source breakdown.
  const ev = loadIdx("load.ev");
  if (ev >= 0) {
    const kwh = sumCol(attr.energyKwh, ev);
    const g = sumCol(attr.emissionsG, ev);
    const gKwh = sumCol(attr.emissionsKnownKwh, ev);
    const rkwh = sumCol(attr.renewableKwh, ev);
    const rKwh = sumCol(attr.renewableKnownKwh, ev);
    const c = sumCol(attr.costC, ev);
    const cKwh = sumCol(attr.priceKnownKwh, ev);
    const estKwh = sumCol(attr.estimatedKwh, ev);
    console.log(`\n=== EV charging over window (${kwh.toFixed(1)} kWh) ===`);
    console.log(
      `  cost:            $${(c / 100).toFixed(2)}  (avg ${cKwh > 0 ? (c / cKwh).toFixed(1) : "--"} c/kWh)`,
    );
    console.log(
      `  renewable:       ${rKwh > 0 ? ((100 * rkwh) / rKwh).toFixed(0) : "--"}%`,
    );
    console.log(
      `  emissions:       ${gKwh > 0 ? (g / gKwh).toFixed(0) : "--"} g/kWh  (${(g / 1000).toFixed(2)} kg total)`,
    );
    console.log(
      `  estimated:       ${((100 * estKwh) / Math.max(kwh, 1e-9)).toFixed(0)}% of energy`,
    );
    console.log("  by source:");
    for (let s = 0; s < attr.sources.length; s++) {
      const e = attr.energyKwh[s][ev];
      if (e > 0.05)
        console.log(`    ${attr.sources[s].padEnd(20)} ${e.toFixed(1)} kWh`);
    }
  } else {
    console.log(
      "\n(No load.ev node in this Area — EV not separately metered here.)",
    );
  }

  // ---- model internals / inspector panel ----
  const socStart = soc.find((v) => v !== null) ?? null;
  const socEnd = [...soc].reverse().find((v) => v !== null) ?? null;
  const fs = finalState;
  console.log("\n=== Battery model internals ===");
  console.log(
    `  round-trip efficiency:  Σout ${fs.totalDischargeKwh.toFixed(0)} / Σin ${fs.totalChargeKwh.toFixed(0)} = ` +
      `${((100 * fs.totalDischargeKwh) / Math.max(fs.totalChargeKwh, 1e-9)).toFixed(1)}%` +
      (socStart != null && socEnd != null
        ? `  (SoC ${socStart.toFixed(0)}→${socEnd.toFixed(0)}%, Δ${(socEnd - socStart).toFixed(0)}pp bias)`
        : "  (no SoC — trust over a long window)"),
  );
  console.log(
    `  inferred usable capacity: ${fs.maxObservedCapacityKwh.toFixed(1)} kWh (max E between bottom-outs)`,
  );
  console.log(
    `  resets: ${fs.resetsEmpty} empty + ${fs.resetsSocFloor} soc-floor + ${fs.resetsBackstop} backstop` +
      ` = ${fs.resetsEmpty + fs.resetsSocFloor + fs.resetsBackstop} total`,
  );
  console.log(
    `  round-trip LOSS (priced into delivered): ${fs.roundtripLossKwh.toFixed(1)} kWh, ` +
      `$${(fs.roundtripLossC / 100).toFixed(2)}, ${(fs.roundtripLossG / 1000).toFixed(1)} kg CO2`,
  );
  console.log(
    `  UNATTRIBUTED loss (drift/forced-reset residual): ${fs.unattribLossKwh.toFixed(1)} kWh, ` +
      `$${(fs.unattribLossC / 100).toFixed(2)}, ${(fs.unattribLossG / 1000).toFixed(1)} kg CO2`,
  );

  // Conservation self-audit (fold-internal, exact by construction): every gram charged into the
  // battery is vended to a load, discarded as unattributed loss, or still stored at the end.
  let chargedG = 0;
  for (const it of intervals) {
    if (it.gridChargeKwh > 0 && it.gridEmissionsIntensity !== null)
      chargedG += it.gridChargeKwh * it.gridEmissionsIntensity;
  }
  let foldVendedG = 0;
  for (const s of steps)
    foldVendedG += s.dischargedKwh * (s.batteryEmissionsIntensity ?? 0);
  const auditG = chargedG - (foldVendedG + fs.unattribLossG + fs.carbonG);
  const auditPct = (100 * Math.abs(auditG)) / Math.max(chargedG, 1e-9);
  console.log(
    `  conservation (carbon): charged ${(chargedG / 1000).toFixed(1)} = vended ${(foldVendedG / 1000).toFixed(1)} ` +
      `+ unattrib ${(fs.unattribLossG / 1000).toFixed(1)} + stored ${(fs.carbonG / 1000).toFixed(1)} kg ` +
      `→ residual ${auditPct.toFixed(2)}% ${auditPct < 0.5 ? "✓" : "⚠"}`,
  );

  // Coverage / confidence.
  const totalEnergy = energy.totalEnergy;
  const totalEst = attr.estimatedKwh.flat().reduce((a, b) => a + b, 0);
  console.log(
    `  coverage: total flow ${totalEnergy.toFixed(0)} kWh, estimated ${((100 * totalEst) / Math.max(totalEnergy, 1e-9)).toFixed(0)}%`,
  );
}

async function main() {
  const idres: any = await db().execute(
    sql`select current_user as usr, current_database() as dbname`,
  );
  const id = idres.rows?.[0] ?? idres[0] ?? {};
  console.log(`[DB] connected as ${id.usr}@${id.dbname} (READ-ONLY replay)`);

  if (DISCOVER) return runDiscover();
  if (SYSTEM == null) {
    console.log("Pass --system=<handle> (or --discover to list candidates).");
    return;
  }
  await runReplay(SYSTEM);
}

main()
  .then(() => process.exit(0))
  .catch((e) => {
    console.error(e);
    process.exit(1);
  });
