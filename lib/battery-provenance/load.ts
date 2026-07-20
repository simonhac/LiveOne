/**
 * Battery-provenance loader — the I/O half of the engine. Resolves an Area's CURATED points via
 * `area_bindings` (deduping overlapping devices), reads their `agg_5m`, resamples everything onto one
 * 5-minute timeline, and returns a {@link ProvenanceInputs} the pure compute can fold. Used identically
 * by the prod driver and the offline harness. Keeping this separate from `compute` lets the harness
 * load a window ONCE and sweep many configs.
 *
 * POWER vs ENERGY registers: flow-series inputs read POWER (`avg`), but battery charge/discharge are
 * preferred from ENERGY registers (`delta`, exact interval energy) when the Area binds them.
 */

import { and, asc, eq, gte, lte, or } from "drizzle-orm";
import { planetscaleDb } from "@/lib/db/planetscale";
import {
  areaBindings,
  areas,
  batteryProvenanceDaily,
  pointInfo,
  pointReadingsAgg5m,
  systems,
} from "@/lib/db/planetscale/schema";
import { applyPowerTransform } from "@/lib/aggregation/flow-series";
import { loadFlowSeriesFromAgg5m } from "@/lib/aggregation/flow-series-pg";
import {
  resolveLogicalSystem,
  type LogicalSystem,
} from "@/lib/aggregation/logical-system";
import { nemRegionForLocation } from "@/lib/vendors/openelectricity/region";
import type { AreaLocation } from "@/lib/areas/types";
import type { ExportTariffConfig } from "@/lib/capabilities/config";
import { DEFAULT_RESERVE_PCT } from "./reserve-floor";
import type { ProvenanceInputs, ProvenanceWindow } from "./types";

const FIVE_MIN_MS = 5 * 60 * 1000;

type PgDb = NonNullable<typeof planetscaleDb>;

const oeEmissionsToGPerKwh = (v: number | null) =>
  v === null ? null : v * 1000; // OE tCO2e/MWh → gCO2/kWh
const toKw = (v: number | null, unit: string | null) =>
  v === null ? null : unit === "W" || unit === "Wh" ? v / 1000 : v;
const toKwh = (v: number | null, unit: string | null) =>
  v === null ? null : unit === "Wh" ? v / 1000 : v;

interface SeriesPoint {
  t: number;
  v: number | null;
  dq: string | null;
}

async function readAgg5m(
  db: PgDb,
  systemId: number,
  pointId: number,
  startMs: number,
  endMs: number,
  column: "avg" | "delta" = "avg",
): Promise<SeriesPoint[]> {
  const col =
    column === "delta" ? pointReadingsAgg5m.delta : pointReadingsAgg5m.avg;
  const rows = await db
    .select({
      t: pointReadingsAgg5m.intervalEnd,
      v: col,
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

/** Raw OE emissions-intensity + renewables series for `region` (unprocessed — caller forward-fills).
 *  `null` for a leg that has no OE system/point registered for the region. Three sequential round
 *  trips are inherent (system lookup → point lookup → point reads), but the two point reads (once
 *  point ids are known) run concurrently, and the whole chain runs alongside every other independent
 *  read in the caller's `Promise.all`. */
async function loadOeRawSeries(
  db: PgDb,
  region: string | null,
  startMs: number,
  endMs: number,
  oeFillMs: number,
): Promise<{
  emissions: SeriesPoint[] | null;
  renewable: SeriesPoint[] | null;
}> {
  if (!region) return { emissions: null, renewable: null };
  const [oeSys] = await db
    .select({ id: systems.id })
    .from(systems)
    .where(
      and(
        eq(systems.vendorType, "openelectricity"),
        eq(systems.vendorSiteId, region),
      ),
    )
    .limit(1);
  if (!oeSys) return { emissions: null, renewable: null };
  const oePts = await db
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
  const results = await Promise.all(
    oePts.map(async (op) => ({
      stem: op.stem,
      series: await readAgg5m(
        db,
        oeSys.id,
        op.pointId,
        startMs - oeFillMs,
        endMs,
      ),
    })),
  );
  return {
    emissions:
      results.find((r) => r.stem === "grid.emissionsIntensity")?.series ?? null,
    renewable:
      results.find((r) => r.stem === "grid.renewables")?.series ?? null,
  };
}

/** Forward-fill a source series onto the target timeline (≤ maxStaleMs); flags fills / non-good quality. */
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

/** Scatter an interval-keyed series onto the exact timeline slots (no fill) — for 5-min-native registers. */
function scatter(
  timeline: number[],
  tIndex: Map<number, number>,
  src: SeriesPoint[],
  transform: (v: number | null) => number | null,
): (number | null)[] {
  const out = new Array<number | null>(timeline.length).fill(null);
  for (const s of src) {
    const i = tIndex.get(s.t);
    if (i !== undefined) out[i] = transform(s.v);
  }
  return out;
}

export interface BoundPoint {
  systemId: number;
  pointId: number;
  role: string;
  metric: string;
  stem: string | null;
  unit: string | null;
  transform: string | null;
}

/** The Area's curated points via `area_bindings` joined to point_info (dedupes overlapping devices). */
export async function boundPoints(
  db: PgDb,
  areaId: string,
): Promise<BoundPoint[]> {
  const rows = await db
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
    transform: r.transform ?? r.piTransform,
  }));
}

export interface LoadOptions {
  /** Ablation: pretend SoC is unavailable (harness `--no-soc`). */
  noSoc?: boolean;
  /** Ablation: ignore the persisted capacity point, forcing the in-window fallback (harness `--no-capacity`). */
  noCapacity?: boolean;
  /** Pre-resolved logical system for `handle`, when the caller already has one (e.g. `/api/history`
   *  resolves it once for the energy-only Sankey and can hand it straight in here) — skips the
   *  internal `resolveLogicalSystem` call. Must be the same `handle`; not verified. */
  logicalSystem?: LogicalSystem;
}

/**
 * Load one Area's provenance inputs over `window`. Returns null when the Area / a complete source-load
 * role set / a timeline can't be resolved (the caller reports "nothing to serve").
 */
export async function loadProvenanceInputs(
  handle: number,
  window: ProvenanceWindow,
  opts: LoadOptions = {},
): Promise<ProvenanceInputs | null> {
  const db = planetscaleDb;
  if (!db)
    throw new Error("No Postgres connection (PLANETSCALE_DATABASE_URL).");
  const { startMs, endMs } = window;

  // The Area lookup and the logical-system resolve are independent (the latter needs only `handle`)
  // — fire concurrently. Flow series (source/load kW) are built from the SAME canonical
  // `resolveLogicalSystem` + shared PG builder the Sankey reads, so the attributed matrix's edges
  // match by construction — per-inverter solar-leaf granularity and area-of-ones (which have no power
  // `area_bindings`) are covered too. This assembly is deliberately kept directly callable with an
  // arbitrary {startMs, endMs} window so read paths (history/tooltips) can reuse it without
  // reconstructing the flow-series build.
  const [[area], ls] = await Promise.all([
    db
      .select({
        id: areas.id,
        location: areas.location,
        tz: areas.timezoneOffsetMin,
      })
      .from(areas)
      .where(eq(areas.legacySystemId, handle))
      .limit(1),
    opts.logicalSystem
      ? Promise.resolve(opts.logicalSystem)
      : resolveLogicalSystem(handle),
  ]);
  if (!area) return null;
  if (!ls) return null;

  const PARAM_FILL_MS = 48 * 60 * 60 * 1000;

  // The curated points, the flow-series build, and the persisted per-day learned params are mutually
  // independent (each needs only `area.id` or `ls`, not one another's output) — fire concurrently.
  // Persisted per-day learned params (η / C / η_c / idle) come from `battery_provenance_daily`
  // (learn-in-shell / read-in-fold) — natural units (ratios / kWh / kWh-per-day), each day's value
  // anchored at the day's first interval_end and forward-filled ≤48h onto the timeline below. The read
  // has a 48h LEAD-IN so the last pre-window step carries into the window (a midnight-anchored window
  // still sees yesterday's params). A series with NO rows (never learned / SoC-blind / pre-activation)
  // stays undefined → compute falls back to its in-window bootstrap, exactly as when the old param
  // points were unbound.
  const [bound, flowBundle, paramRows] = await Promise.all([
    boundPoints(db, area.id),
    loadFlowSeriesFromAgg5m(db, ls.points, startMs, endMs),
    db
      .select({
        t: batteryProvenanceDaily.firstIntervalEnd,
        eta: batteryProvenanceDaily.eta,
        capacityKwh: batteryProvenanceDaily.capacityKwh,
        chargeEff: batteryProvenanceDaily.chargeEff,
        idleLossKwhDay: batteryProvenanceDaily.idleLossKwhDay,
        reserveFloorPct: batteryProvenanceDaily.reserveFloorPct,
      })
      .from(batteryProvenanceDaily)
      .where(
        and(
          eq(batteryProvenanceDaily.areaId, area.id),
          gte(
            batteryProvenanceDaily.firstIntervalEnd,
            new Date(startMs - PARAM_FILL_MS),
          ),
          lte(batteryProvenanceDaily.firstIntervalEnd, new Date(endMs)),
        ),
      )
      .orderBy(asc(batteryProvenanceDaily.firstIntervalEnd)),
  ]);
  const { timeline, sources, loads } = flowBundle;
  if (timeline.length < 2 || sources.length === 0 || loads.length === 0)
    return null;
  const tIndex = new Map(timeline.map((t, i) => [t, i]));

  const batterySystemId =
    bound.find((b) => b.role === "battery" && b.metric === "power")?.systemId ??
    null;
  const socBind = bound.find((b) => b.role === "battery" && b.metric === "soc");
  const SOC_FILL_MS = 30 * 60 * 1000;
  const region = nemRegionForLocation(
    (area.location ?? null) as AreaLocation | null,
  );
  const OE_FILL_MS = 15 * 60 * 1000;
  // Amber import price + export/feed-in (bound grid/rate points).
  const rateBinds = bound
    .filter((b) => b.role === "grid" && b.metric === "rate")
    .filter(
      (b) => b.stem === "bidi.grid.import" || b.stem === "bidi.grid.export",
    );
  const RATE_FILL_MS = 35 * 60 * 1000;
  const chargeBind = bound.find(
    (b) => b.metric === "energy" && b.stem === "bidi.battery.charge",
  );
  const dischargeBind = bound.find(
    (b) => b.metric === "energy" && b.stem === "bidi.battery.discharge",
  );

  // Battery SoC, OE region emissions/renewables, Amber rates, the battery's generator-source config,
  // and the exact charge/discharge energy registers are all mutually independent RAW reads — fire them
  // all concurrently, then apply forward-fill/scatter/override (pure, timeline-dependent) synchronously
  // below once everything has landed. Every forward-filled series reads a LEAD-IN of its own fill limit
  // before startMs, so the first in-window slots fill from the last pre-window row exactly as a longer
  // window would — required for the checkpoint-seeded reconcile (its window starts at the checkpoint
  // anchor) and strictly more correct for every caller.
  const [
    socSeries,
    oeSeries,
    rateSeriesResults,
    batSysRow,
    chargeSeries,
    dischargeSeries,
  ] = await Promise.all([
    socBind && !opts.noSoc
      ? readAgg5m(
          db,
          socBind.systemId,
          socBind.pointId,
          startMs - SOC_FILL_MS,
          endMs,
        )
      : Promise.resolve<SeriesPoint[]>([]),
    loadOeRawSeries(db, region, startMs, endMs, OE_FILL_MS),
    Promise.all(
      rateBinds.map((rp) =>
        readAgg5m(
          db,
          rp.systemId,
          rp.pointId,
          startMs - RATE_FILL_MS,
          endMs,
        ).then((s) => ({ stem: rp.stem, s })),
      ),
    ),
    batterySystemId != null
      ? db
          .select({ config: systems.config })
          .from(systems)
          .where(eq(systems.id, batterySystemId))
          .limit(1)
          .then((r) => r[0])
      : Promise.resolve(undefined),
    chargeBind
      ? readAgg5m(
          db,
          chargeBind.systemId,
          chargeBind.pointId,
          startMs,
          endMs,
          "delta",
        )
      : Promise.resolve(undefined),
    dischargeBind
      ? readAgg5m(
          db,
          dischargeBind.systemId,
          dischargeBind.pointId,
          startMs,
          endMs,
          "delta",
        )
      : Promise.resolve(undefined),
  ]);

  const soc = opts.noSoc
    ? new Array<number | null>(timeline.length).fill(null)
    : forwardFill(timeline, socSeries, SOC_FILL_MS).value;

  let gridEmissions = new Array<number | null>(timeline.length).fill(null);
  let gridEmissionsEstimated = new Array<boolean>(timeline.length).fill(true);
  let gridRenewable = new Array<number | null>(timeline.length).fill(null);
  if (oeSeries.emissions) {
    const ff = forwardFill(timeline, oeSeries.emissions, OE_FILL_MS);
    gridEmissions = ff.value.map(oeEmissionsToGPerKwh);
    gridEmissionsEstimated = ff.estimated;
  }
  if (oeSeries.renewable) {
    const ff = forwardFill(timeline, oeSeries.renewable, OE_FILL_MS);
    gridRenewable = ff.value.map((v) => (v === null ? null : v / 100));
  }

  // `rateSeriesResults` preserves `rateBinds`' order, so a duplicate binding still resolves
  // "last one wins" exactly as the original sequential loop did.
  let gridPrice = new Array<number | null>(timeline.length).fill(null);
  let gridPriceEstimated = new Array<boolean>(timeline.length).fill(true);
  let gridExportPrice = new Array<number | null>(timeline.length).fill(null);
  for (const { stem, s } of rateSeriesResults) {
    const ff = forwardFill(timeline, s, RATE_FILL_MS);
    if (stem === "bidi.grid.import") {
      gridPrice = ff.value;
      gridPriceEstimated = ff.estimated;
    } else {
      gridExportPrice = ff.value;
    }
  }

  // GENERATOR source: if the battery system declares a batteryProvenance.generatorSource, the inverter's
  // AC-input ("bidi.grid") is a GENERATOR, not a mains grid — price that "grid" energy with the configured
  // constants, OVERRIDING any OE/Amber region signal above. Setting generatorSource IS the explicit
  // statement that this site's grid port is a generator, so it wins even when the area is geolocated in a
  // NEM region (an off-grid site can still be in VIC without being on the VIC1 grid). (bidi.grid's own `i`
  // transform flips the Selectronic's raw sign so generator supply reads as positive import → source.grid.)
  let exportTariff: ExportTariffConfig | undefined;
  if (batterySystemId != null) {
    // Solar opportunity-cost source (none/amber/schedule); resolved to a series in `compute`.
    exportTariff = batSysRow?.config?.batteryProvenance?.exportTariff;
    const gen = batSysRow?.config?.batteryProvenance?.generatorSource;
    if (gen && Number.isFinite(gen.emissionsIntensity)) {
      gridEmissions = timeline.map(() => gen.emissionsIntensity);
      gridEmissionsEstimated = timeline.map(() => false);
      gridRenewable = timeline.map(() =>
        Number.isFinite(gen.renewableFraction) ? gen.renewableFraction : 0,
      );
      if (Number.isFinite(gen.pricePerKwh)) {
        gridPrice = timeline.map(() => gen.pricePerKwh);
        gridPriceEstimated = timeline.map(() => false);
      }
    }
  }

  // ENERGY-register seam: prefer exact battery charge/discharge energy when the Area binds them.
  const batteryChargeEnergyKwh = chargeSeries
    ? scatter(timeline, tIndex, chargeSeries, (v) => toKwh(v, chargeBind!.unit))
    : undefined;
  const batteryDischargeEnergyKwh = dischargeSeries
    ? scatter(timeline, tIndex, dischargeSeries, (v) =>
        toKwh(v, dischargeBind!.unit),
      )
    : undefined;

  const paramSeries = (
    pick: (r: (typeof paramRows)[number]) => number | null,
  ): (number | null)[] | undefined => {
    const pts: SeriesPoint[] = [];
    for (const r of paramRows) {
      const v = pick(r);
      if (r.t !== null && v !== null)
        pts.push({ t: r.t.getTime(), v, dq: "good" });
    }
    if (pts.length === 0) return undefined;
    return forwardFill(timeline, pts, PARAM_FILL_MS).value;
  };
  const etaSeries = paramSeries((r) => r.eta);
  const capacitySeries = opts.noCapacity
    ? undefined
    : paramSeries((r) => r.capacityKwh);
  const chargeEfficiencySeries = paramSeries((r) => r.chargeEff);
  const idleLossKwhPerDaySeries = paramSeries((r) => r.idleLossKwhDay);
  // Reserve floor: the persisted per-day APPLIED floor (learned in the daily shell; see reserve-floor.ts),
  // read back as a per-interval series exactly like C. `estReservePct` is the latest value in the window —
  // the scalar fallback for any interval whose series entry is null (warm-up / pre-activation) and for the
  // checkpoint envelope. No SoC-blind guard needed: the learn stores the maxPct prior there.
  const reserveFloorPctSeries = paramSeries((r) => r.reserveFloorPct);
  const lastNonNull = (a: (number | null)[] | undefined): number | null => {
    if (!a) return null;
    for (let i = a.length - 1; i >= 0; i--) if (a[i] !== null) return a[i];
    return null;
  };
  const estReservePct =
    lastNonNull(reserveFloorPctSeries) ?? DEFAULT_RESERVE_PCT;

  const frac = (a: (number | null)[]) =>
    a.filter((v) => v !== null).length / Math.max(a.length, 1);

  return {
    handle,
    areaId: area.id,
    region,
    batterySystemId,
    timezoneOffsetMin: area.tz,
    timeline,
    sources,
    loads,
    gridEmissions,
    gridEmissionsEstimated,
    gridRenewable,
    gridPrice,
    gridPriceEstimated,
    gridExportPrice,
    exportTariff,
    soc,
    estReservePct,
    reserveFloorPctSeries,
    batteryChargeEnergyKwh,
    batteryDischargeEnergyKwh,
    etaSeries,
    capacitySeries,
    chargeEfficiencySeries,
    idleLossKwhPerDaySeries,
    coverage: {
      soc: frac(soc),
      emissions: frac(gridEmissions),
      price: frac(gridPrice),
    },
  };
}

export interface BatteryThroughput {
  areaId: string;
  timezoneOffsetMin: number;
  timeline: number[];
  /** Total charge INTO the battery per interval (kWh ≥ 0). */
  chargeKwh: number[];
  /** Total discharge OUT of the battery per interval (kWh ≥ 0). */
  dischargeKwh: number[];
  /** Battery SoC (%) forward-filled onto the timeline (null where unavailable) — for the capacity-learn pass. */
  soc: (number | null)[];
}

/**
 * Lean loader for the η- and capacity-learn passes — the battery's per-interval charge/discharge energy (and
 * SoC) over the window. Prefers exact energy registers (bidi.battery.charge/discharge deltas); else integrates
 * the signed battery power (negative = charge, positive = discharge). Fold-INDEPENDENT (η/C are functions of
 * raw throughput + SoC, so there is no circularity: raw signals → η(t)/C(t) → fold). Returns null if no
 * battery signal.
 */
export async function loadBatteryThroughput(
  handle: number,
  window: ProvenanceWindow,
): Promise<BatteryThroughput | null> {
  const db = planetscaleDb;
  if (!db) throw new Error("No Postgres connection.");
  const { startMs, endMs } = window;

  const [area] = await db
    .select({ id: areas.id, tz: areas.timezoneOffsetMin })
    .from(areas)
    .where(eq(areas.legacySystemId, handle))
    .limit(1);
  if (!area) return null;

  const bound = await boundPoints(db, area.id);
  const powerBind = bound.find(
    (b) => b.role === "battery" && b.metric === "power",
  );
  if (!powerBind) return null;

  const powerSeries = await readAgg5m(
    db,
    powerBind.systemId,
    powerBind.pointId,
    startMs,
    endMs,
  );
  if (powerSeries.length < 2) return null;
  const timeline = powerSeries.map((s) => s.t);
  const tIndex = new Map(timeline.map((t, i) => [t, i]));

  const chargeKwh = new Array<number>(timeline.length).fill(0);
  const dischargeKwh = new Array<number>(timeline.length).fill(0);

  const chargeBind = bound.find(
    (b) => b.metric === "energy" && b.stem === "bidi.battery.charge",
  );
  const dischargeBind = bound.find(
    (b) => b.metric === "energy" && b.stem === "bidi.battery.discharge",
  );
  if (chargeBind && dischargeBind) {
    // Exact energy registers (per-interval delta), scattered onto the timeline.
    const cs = await readAgg5m(
      db,
      chargeBind.systemId,
      chargeBind.pointId,
      startMs,
      endMs,
      "delta",
    );
    const ds = await readAgg5m(
      db,
      dischargeBind.systemId,
      dischargeBind.pointId,
      startMs,
      endMs,
      "delta",
    );
    for (const s of cs) {
      const i = tIndex.get(s.t);
      if (i !== undefined)
        chargeKwh[i] = Math.max(0, toKwh(s.v, chargeBind.unit) ?? 0);
    }
    for (const s of ds) {
      const i = tIndex.get(s.t);
      if (i !== undefined)
        dischargeKwh[i] = Math.max(0, toKwh(s.v, dischargeBind.unit) ?? 0);
    }
  } else {
    // Integrate signed battery power over each 5-min interval (negative = charge, positive = discharge).
    const hours = FIVE_MIN_MS / 3_600_000;
    for (let i = 0; i < powerSeries.length; i++) {
      const kw = applyPowerTransform(
        toKw(powerSeries[i].v, powerBind.unit),
        powerBind.transform,
      );
      if (kw == null) continue;
      if (kw < 0) chargeKwh[i] = -kw * hours;
      else dischargeKwh[i] = kw * hours;
    }
  }

  // SoC (forward-filled ≤30 min) for the capacity-learn pass — null everywhere when no SoC point is bound.
  const socBind = bound.find((b) => b.role === "battery" && b.metric === "soc");
  const socSeries = socBind
    ? await readAgg5m(db, socBind.systemId, socBind.pointId, startMs, endMs)
    : [];
  const soc = forwardFill(timeline, socSeries, 30 * 60 * 1000).value;

  return {
    areaId: area.id,
    timezoneOffsetMin: area.tz,
    timeline,
    chargeKwh,
    dischargeKwh,
    soc,
  };
}
