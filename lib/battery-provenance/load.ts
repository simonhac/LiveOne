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
import { kv, kvKey } from "@/lib/kv";
import type { AreaLocation } from "@/lib/areas/types";
import type { ProvenanceInputs, ProvenanceWindow } from "./types";

const FIVE_MIN_MS = 5 * 60 * 1000;
const DEFAULT_RESERVE_PCT = 10;

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

interface BoundPoint {
  systemId: number;
  pointId: number;
  role: string;
  metric: string;
  stem: string | null;
  unit: string | null;
  transform: string | null;
}

/** The Area's curated points via `area_bindings` joined to point_info (dedupes overlapping devices). */
async function boundPoints(db: PgDb, areaId: string): Promise<BoundPoint[]> {
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

  // Battery SoC (optional).
  const socBind = bound.find((b) => b.role === "battery" && b.metric === "soc");
  const socSeries =
    socBind && !opts.noSoc
      ? await readAgg5m(db, socBind.systemId, socBind.pointId, startMs, endMs)
      : [];
  const soc = opts.noSoc
    ? new Array<number | null>(timeline.length).fill(null)
    : forwardFill(timeline, socSeries, 30 * 60 * 1000).value;

  // Reserve floor = ~2nd percentile of SoC over a LONG (90d) window (robust to non-cycling). CACHED in KV
  // with a ~25h TTL: the 90d read is ~1.5s, so we recompute it at most ~once/day and every other reconcile
  // reads the cached scalar — off the hot path, and STABLE within a day (consistent reconcile-vs-heal).
  // KV-unconfigured (dev) → get/set no-op to null → falls back to recomputing every call (current behaviour).
  let estReservePct = DEFAULT_RESERVE_PCT;
  if (socBind && !opts.noSoc) {
    const floorKey = kvKey(`batprov:reserve-floor:area:${area.id}`);
    let cached: number | null = null;
    try {
      cached = await kv.get<number>(floorKey);
    } catch {
      cached = null;
    }
    if (cached != null) {
      estReservePct = cached;
    } else {
      const longSoc = await readAgg5m(
        db,
        socBind.systemId,
        socBind.pointId,
        endMs - 90 * 24 * 3600 * 1000,
        endMs,
      );
      const vals = longSoc
        .map((s) => s.v)
        .filter((v): v is number => v !== null)
        .sort((a, b) => a - b);
      if (vals.length > 20)
        estReservePct = vals[Math.floor(0.02 * vals.length)];
      try {
        await kv.set(floorKey, estReservePct, { ex: 90_000 }); // ~25h
      } catch {
        /* KV not configured (dev) — recompute next call */
      }
    }
  }

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
      for (const op of oePts) {
        const s = await readAgg5m(db, oeSys.id, op.pointId, startMs, endMs);
        const ff = forwardFill(timeline, s, 15 * 60 * 1000);
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
  for (const rp of rateBinds) {
    if (rp.stem !== "bidi.grid.import" && rp.stem !== "bidi.grid.export")
      continue;
    const s = await readAgg5m(db, rp.systemId, rp.pointId, startMs, endMs);
    const ff = forwardFill(timeline, s, 35 * 60 * 1000);
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
  if (batterySystemId != null) {
    const [batSys] = await db
      .select({ config: systems.config })
      .from(systems)
      .where(eq(systems.id, batterySystemId))
      .limit(1);
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

  // Persisted round-trip efficiency η(t) from the helper's round-trip-efficiency point (learn-in-shell /
  // read-in-fold): stored as % (η×100), forward-filled onto the timeline (a daily step), ÷100 → the ratio
  // the fold consumes. Absent (not yet learned) → undefined → compute falls back to an in-window learned η.
  let etaSeries: (number | null)[] | undefined;
  const etaBind = bound.find(
    (b) => b.role === "battery" && b.metric === "round-trip-efficiency",
  );
  if (etaBind) {
    const s = await readAgg5m(
      db,
      etaBind.systemId,
      etaBind.pointId,
      startMs,
      endMs,
    );
    etaSeries = forwardFill(timeline, s, 48 * 60 * 60 * 1000).value.map((v) =>
      v === null ? null : v / 100,
    );
  }

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
    soc,
    estReservePct,
    batteryChargeEnergyKwh,
    batteryDischargeEnergyKwh,
    etaSeries,
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
}

/**
 * Lean loader for the η-learn pass — just the battery's per-interval charge/discharge energy over the
 * window. Prefers exact energy registers (bidi.battery.charge/discharge deltas); else integrates the signed
 * battery power (negative = charge, positive = discharge). Fold-INDEPENDENT (η is a function of raw
 * throughput, so there is no circularity: raw energies → η(t) → fold). Returns null if no battery signal.
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

  return {
    areaId: area.id,
    timezoneOffsetMin: area.tz,
    timeline,
    chargeKwh,
    dischargeKwh,
  };
}
