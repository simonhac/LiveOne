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
import {
  applyPowerTransform,
  buildFlowSeries,
  ClassifiedPoint,
} from "@/lib/aggregation/flow-series";
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

  const [area] = await db
    .select({
      id: areas.id,
      location: areas.location,
      tz: areas.timezoneOffsetMin,
    })
    .from(areas)
    .where(eq(areas.legacySystemId, handle))
    .limit(1);
  if (!area) return null;

  const bound = await boundPoints(db, area.id);
  const powerPoints = bound.filter((b) => b.metric === "power" && b.stem);
  const batterySystemId =
    bound.find((b) => b.role === "battery" && b.metric === "power")?.systemId ??
    null;

  const perPoint = await Promise.all(
    powerPoints.map(async (p) => ({
      p,
      series: await readAgg5m(db, p.systemId, p.pointId, startMs, endMs),
    })),
  );
  const tset = new Set<number>();
  for (const { series } of perPoint) for (const s of series) tset.add(s.t);
  const timeline = [...tset].sort((a, b) => a - b);
  if (timeline.length < 2) return null;
  const tIndex = new Map(timeline.map((t, i) => [t, i]));

  const classified: ClassifiedPoint[] = perPoint.map(({ p, series }) => ({
    stem: p.stem!,
    power: scatter(timeline, tIndex, series, (v) =>
      applyPowerTransform(toKw(v, p.unit), p.transform),
    ),
  }));
  const { sources, loads } = buildFlowSeries(classified);
  if (sources.length === 0 || loads.length === 0) return null;

  // Battery SoC (optional). Every forward-filled series reads a LEAD-IN of its own fill limit before
  // startMs, so the first in-window slots fill from the last pre-window row exactly as a longer window
  // would — required for the checkpoint-seeded reconcile (its window starts at the checkpoint anchor)
  // and strictly more correct for every caller.
  const socBind = bound.find((b) => b.role === "battery" && b.metric === "soc");
  const SOC_FILL_MS = 30 * 60 * 1000;
  const socSeries =
    socBind && !opts.noSoc
      ? await readAgg5m(
          db,
          socBind.systemId,
          socBind.pointId,
          startMs - SOC_FILL_MS,
          endMs,
        )
      : [];
  const soc = opts.noSoc
    ? new Array<number | null>(timeline.length).fill(null)
    : forwardFill(timeline, socSeries, SOC_FILL_MS).value;

  // OE region emissions + renewables (from the Area's location).
  const region = nemRegionForLocation(
    (area.location ?? null) as AreaLocation | null,
  );
  let gridEmissions = new Array<number | null>(timeline.length).fill(null);
  let gridEmissionsEstimated = new Array<boolean>(timeline.length).fill(true);
  let gridRenewable = new Array<number | null>(timeline.length).fill(null);
  if (region) {
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
    if (oeSys) {
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
      const OE_FILL_MS = 15 * 60 * 1000;
      for (const op of oePts) {
        const s = await readAgg5m(
          db,
          oeSys.id,
          op.pointId,
          startMs - OE_FILL_MS,
          endMs,
        );
        const ff = forwardFill(timeline, s, OE_FILL_MS);
        if (op.stem === "grid.emissionsIntensity") {
          gridEmissions = ff.value.map(oeEmissionsToGPerKwh);
          gridEmissionsEstimated = ff.estimated;
        } else {
          gridRenewable = ff.value.map((v) => (v === null ? null : v / 100));
        }
      }
    }
  }

  // Amber import price + export/feed-in (bound grid/rate points).
  const rateBinds = bound.filter(
    (b) => b.role === "grid" && b.metric === "rate",
  );
  let gridPrice = new Array<number | null>(timeline.length).fill(null);
  let gridPriceEstimated = new Array<boolean>(timeline.length).fill(true);
  let gridExportPrice = new Array<number | null>(timeline.length).fill(null);
  const RATE_FILL_MS = 35 * 60 * 1000;
  for (const rp of rateBinds) {
    if (rp.stem !== "bidi.grid.import" && rp.stem !== "bidi.grid.export")
      continue;
    const s = await readAgg5m(
      db,
      rp.systemId,
      rp.pointId,
      startMs - RATE_FILL_MS,
      endMs,
    );
    const ff = forwardFill(timeline, s, RATE_FILL_MS);
    if (rp.stem === "bidi.grid.import") {
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
    const [batSys] = await db
      .select({ config: systems.config })
      .from(systems)
      .where(eq(systems.id, batterySystemId))
      .limit(1);
    // Solar opportunity-cost source (none/amber/schedule); resolved to a series in `compute`.
    exportTariff = batSys?.config?.batteryProvenance?.exportTariff;
    const gen = batSys?.config?.batteryProvenance?.generatorSource;
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
  let batteryChargeEnergyKwh: (number | null)[] | undefined;
  let batteryDischargeEnergyKwh: (number | null)[] | undefined;
  const chargeBind = bound.find(
    (b) => b.metric === "energy" && b.stem === "bidi.battery.charge",
  );
  const dischargeBind = bound.find(
    (b) => b.metric === "energy" && b.stem === "bidi.battery.discharge",
  );
  if (chargeBind) {
    const s = await readAgg5m(
      db,
      chargeBind.systemId,
      chargeBind.pointId,
      startMs,
      endMs,
      "delta",
    );
    batteryChargeEnergyKwh = scatter(timeline, tIndex, s, (v) =>
      toKwh(v, chargeBind.unit),
    );
  }
  if (dischargeBind) {
    const s = await readAgg5m(
      db,
      dischargeBind.systemId,
      dischargeBind.pointId,
      startMs,
      endMs,
      "delta",
    );
    batteryDischargeEnergyKwh = scatter(timeline, tIndex, s, (v) =>
      toKwh(v, dischargeBind.unit),
    );
  }

  // Persisted per-day learned params (η / C / η_c / idle) from `battery_provenance_daily`
  // (learn-in-shell / read-in-fold) — natural units (ratios / kWh / kWh-per-day), each day's value
  // anchored at the day's first interval_end and forward-filled ≤48h onto the timeline. The read has a
  // 48h LEAD-IN so the last pre-window step carries into the window (a midnight-anchored window still
  // sees yesterday's params). A series with NO rows (never learned / SoC-blind / pre-activation) stays
  // undefined → compute falls back to its in-window bootstrap, exactly as when the old param points
  // were unbound.
  const PARAM_FILL_MS = 48 * 60 * 60 * 1000;
  const paramRows = await db
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
    .orderBy(asc(batteryProvenanceDaily.firstIntervalEnd));
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
