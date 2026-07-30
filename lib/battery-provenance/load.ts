/**
 * Battery-provenance loader — the I/O half of the engine. Resolves an Area's CURATED points via
 * `area_bindings` (deduping overlapping devices), reads their `agg_5m`, resamples everything onto one
 * 5-minute timeline, and returns a {@link ProvenanceInputs} the pure compute can fold. Used identically
 * by the prod driver and the offline harness. Keeping this separate from `compute` lets the harness
 * load a window ONCE and sweep many configs.
 *
 * POWER vs ENERGY registers: the flow-series build itself prefers exact ENERGY accumulators
 * (`LogicalSystem.energyPoints` → `FlowSeries.energyKwh` overlays) and falls back to integrating
 * POWER (`avg`) per interval — one preference implementation for the whole pipeline (flow matrix,
 * Sankey, and the fold's battery flows alike); see flow-series.ts / flow-matrix-core.ts.
 */

import { and, asc, eq, gte, lte, or } from "drizzle-orm";
import { planetscaleDb } from "@/lib/db/planetscale";
import {
  areaBindings,
  areas,
  batteryProvenanceDaily,
  devices,
  pointInfo,
  points,
} from "@/lib/db/planetscale/schema";
import { ReadingsDao } from "@/lib/readings";
import { Point, type PointId } from "@/lib/ids";
import { applyPowerTransform } from "@/lib/aggregation/flow-series";
import { loadFlowSeriesFromAgg5m } from "@/lib/aggregation/flow-series-pg";
import type { Agg5mAvgCache } from "@/lib/history/agg5m-cache";
import { isSettledQuality } from "@/lib/data-quality";
import {
  resolveLogicalSystem,
  type LogicalSystem,
} from "@/lib/aggregation/logical-system";
import { nemRegionForLocation } from "@/lib/vendors/openelectricity/region";
import type { AreaLocation } from "@/lib/areas/types";
import type { ExportTariffConfig } from "@/lib/capabilities/config";
import { resolveGeneratorIntensity } from "./generator-source";
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
  point: PointId | null,
  startMs: number,
  endMs: number,
  column: "avg" | "delta" = "avg",
): Promise<SeriesPoint[]> {
  // The caller supplies the point's identity, so there is nothing to resolve here — a null `point`
  // means the caller has no identity for it, which has no rows (empty, as the old lookup-miss did).
  if (!point) return [];
  const series = await ReadingsDao.read5m(
    [point],
    { fromMs: startMs, toMs: endMs },
    db,
  );
  return series.get(point)!.map((r) => ({
    t: r.intervalEndMs,
    v: column === "delta" ? r.delta : r.avg,
    dq: r.dataQuality,
  }));
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
    .select({ id: devices.rid })
    .from(devices)
    .where(
      and(
        eq(devices.vendor, "openelectricity"),
        eq(devices.vendorSiteId, region),
      ),
    )
    .limit(1);
  if (!oeSys) return { emissions: null, renewable: null };
  const oePts = await db
    .select({
      pointUid: pointInfo.pointUid,
      stem: pointInfo.logicalPathStem,
    })
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
        Point.encode(op.pointUid),
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

/**
 * Forward-fill a source series onto the target timeline (≤ maxStaleMs); flags fills / provisional
 * quality as `estimated`.
 *
 * `nativeIntervalMs` is the series' OWN cadence: a slot is only a "fill" (→ estimated) when it is
 * more than one native interval past the last sample. Up-sampling a natively-coarse series (e.g. a
 * 30-min Amber rate onto the 5-min flow timeline) is NOT a gap-fill, so its between-tick slots must
 * not be flagged. A REAL gap (a missed native interval) still exceeds `nativeIntervalMs` → estimated,
 * and beyond `maxStaleMs` the value nulls out (also estimated). Defaults to `FIVE_MIN_MS` so 5-min
 * native callers (OE, SoC) are unchanged.
 *
 * Exported for unit testing (the estimated-flag semantics behind the "% estimated" chip).
 */
export function forwardFill(
  timeline: number[],
  src: SeriesPoint[],
  maxStaleMs: number,
  nativeIntervalMs: number = FIVE_MIN_MS,
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
      const filled = t - last.t > nativeIntervalMs;
      estimated[i] = filled || (last.dq != null && !isSettledQuality(last.dq));
    } else {
      value[i] = null;
      estimated[i] = true;
    }
  }
  return { value, estimated };
}

/**
 * A binding's `point_uid` as a `PointId`.
 *
 * `area_bindings.point_uid` names the same point as the legacy `(point_system_id, point_id)` pair it
 * replaced (verified 72/72 with zero disagreement on both environments), so reading it is a pure
 * elimination of a `RegistryCache.pointForAddr` round trip (config-v4 Phase 12 slice D). The column is
 * NOT NULL since migration 0047, so there is no miss branch left: slice E's rule is that nullability
 * which preserves behaviour also hides a gap, and here the gap it hid was a writer that never set it.
 */
export function bindingPoint(pointUid: string): PointId {
  return Point.encode(pointUid);
}

export interface BoundPoint {
  /** LEGACY address, read from the point_info row `point_uid` joins to — not from the binding. */
  systemId: number;
  /** LEGACY address (the point's per-device index) — see `systemId`. */
  pointId: number;
  /** The point's identity — see `bindingPoint`. */
  point: PointId;
  role: string;
  metric: string;
  stem: string | null;
  unit: string | null;
  transform: string | null;
}

/**
 * The Area's curated points via `area_bindings` joined to point_info (dedupes overlapping devices).
 *
 * The join is on `point_uid` since slice E PR 2a. `systemId`/`pointId` therefore come from the joined
 * `point_info` row rather than the binding — which is what keeps them a genuine LEGACY side for the
 * slice-D parity gate (`scripts/config-v4/verify-slice-d-parity.ts` block 1 compares `point` against
 * `pointForAddr(systemId, pointId)`; sourcing them from the same uuid would make that check circular).
 * Their remaining production consumers are the two `devices.config` lookups in this module and
 * `battery-provenance-daily-pg.ts`, both of which read the device through `points`/`devices` instead.
 */
export async function boundPoints(
  db: PgDb,
  areaId: string,
): Promise<BoundPoint[]> {
  const rows = await db
    .select({
      systemId: pointInfo.systemId,
      pointId: pointInfo.index,
      pointUid: areaBindings.pointUid,
      role: areaBindings.role,
      metric: areaBindings.metricType,
      stem: pointInfo.logicalPathStem,
      unit: pointInfo.metricUnit,
      transform: areaBindings.transform,
      piTransform: pointInfo.transform,
    })
    .from(areaBindings)
    .innerJoin(pointInfo, eq(pointInfo.pointUid, areaBindings.pointUid))
    .where(eq(areaBindings.areaId, areaId))
    .orderBy(asc(areaBindings.ordinal));
  return rows.map((r) => ({
    systemId: r.systemId,
    pointId: r.pointId,
    point: bindingPoint(r.pointUid),
    role: r.role,
    metric: r.metric,
    stem: r.stem,
    unit: r.unit,
    transform: r.transform ?? r.piTransform,
  }));
}

/**
 * The `devices.config` of the DEVICE that owns `point` — the site-level knobs (battery provenance,
 * generator source, reserve-floor prior) hang off the battery point's device.
 *
 * Resolved `points.device_id → devices.id` since slice E PR 2a; slice K2 deleted the trailing
 * `devices.rid → systems.id` bridge, so this is now a single FK-backed hop and cannot miss for a
 * point that exists. Returns undefined only when the point itself is gone — the same "no knobs, use
 * the defaults" outcome the previous `where(systems.id = pointSystemId)` miss produced.
 */
export async function ownerDeviceConfig(
  db: PgDb,
  point: PointId,
): Promise<(typeof devices.$inferSelect)["config"] | undefined> {
  const [row] = await db
    .select({ config: devices.config })
    .from(points)
    .innerJoin(devices, eq(devices.id, points.deviceId))
    .where(eq(points.id, Point.toUuid(point)))
    .limit(1);
  return row?.config;
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
  /** Request-scoped `agg_5m` avg cache (from the `/api/history` "fetch" span) so the flow-series read
   *  reuses in-window rows instead of re-querying (§1.3a). Only the `/api/history` attr path passes it;
   *  every other caller (engine rollup, harness) omits it and reads exactly as before. */
  avgCache?: Agg5mAvgCache;
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
    loadFlowSeriesFromAgg5m(
      db,
      ls.points,
      startMs,
      endMs,
      opts.avgCache,
      ls.energyPoints,
    ),
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

  // The battery's power binding drives two things: `batterySystemId` (a legacy id, but consumed ONLY
  // as a has-a-battery signal — see `ProvenanceInputs`) and, since slice E PR 2a, the device-config
  // lookup, which now goes through the point's uuid rather than that id.
  const batteryBind = bound.find(
    (b) => b.role === "battery" && b.metric === "power",
  );
  const batterySystemId = batteryBind?.systemId ?? null;
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
  // Amber rates are 30-min native; up-sampling onto the 5-min timeline is not a gap-fill, so only a
  // gap beyond one native interval (a genuinely missed tick) counts as estimated.
  const RATE_NATIVE_MS = 30 * 60 * 1000;

  // Battery SoC, OE region emissions/renewables, Amber rates, and the battery's generator-source
  // config are all mutually independent RAW reads — fire them all concurrently, then apply
  // forward-fill/override (pure, timeline-dependent) synchronously below once everything has landed.
  // Every forward-filled series reads a LEAD-IN of its own fill limit before startMs, so the first
  // in-window slots fill from the last pre-window row exactly as a longer window would — required
  // for the checkpoint-seeded reconcile (its window starts at the checkpoint anchor) and strictly
  // more correct for every caller. (Exact battery charge/discharge registers are no longer read
  // here — they ride in on the flow bundle's `FlowSeries.energyKwh` overlays.)
  const [socSeries, oeSeries, rateSeriesResults, batConfig] = await Promise.all(
    [
      socBind && !opts.noSoc
        ? readAgg5m(db, socBind.point, startMs - SOC_FILL_MS, endMs)
        : Promise.resolve<SeriesPoint[]>([]),
      loadOeRawSeries(db, region, startMs, endMs, OE_FILL_MS),
      Promise.all(
        rateBinds.map((rp) =>
          readAgg5m(db, rp.point, startMs - RATE_FILL_MS, endMs).then((s) => ({
            stem: rp.stem,
            s,
          })),
        ),
      ),
      batteryBind
        ? ownerDeviceConfig(db, batteryBind.point)
        : Promise.resolve(undefined),
    ],
  );

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
    const ff = forwardFill(timeline, s, RATE_FILL_MS, RATE_NATIVE_MS);
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
  if (batteryBind) {
    // Solar opportunity-cost source (none/amber/schedule); resolved to a series in `compute`.
    exportTariff = batConfig?.batteryProvenance?.exportTariff;
    // Shared with run-period provenance — see lib/battery-provenance/generator-source.ts.
    const gen = resolveGeneratorIntensity(
      batConfig?.batteryProvenance?.generatorSource,
    );
    if (gen) {
      gridEmissions = timeline.map(() => gen.gPerKwh);
      gridEmissionsEstimated = timeline.map(() => false);
      gridRenewable = timeline.map(() => gen.renewable);
      const priceC = gen.priceC;
      if (priceC != null) {
        gridPrice = timeline.map(() => priceC);
        gridPriceEstimated = timeline.map(() => false);
      }
    }
  }

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

  const powerSeries = await readAgg5m(db, powerBind.point, startMs, endMs);
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
    const cs = await readAgg5m(db, chargeBind.point, startMs, endMs, "delta");
    const ds = await readAgg5m(
      db,
      dischargeBind.point,
      startMs,
      endMs,
      "delta",
    );
    // A counter re-base is a MATCHED PAIR — one negative delta, then a catch-up carrying everything
    // the counter had accumulated. Clamping the negative to 0 while keeping the catch-up would feed
    // the η/capacity learners a phantom cycle (the same defect fixed in `attachEnergyOverlays`), so
    // drop BOTH halves: the interval reads 0 throughput rather than a fabricated one.
    const scatter = (
      rows: { t: number; v: number | null }[],
      unit: string | null,
      out: number[],
    ): void => {
      let prevNegative = false;
      for (const s of rows) {
        const kwh = toKwh(s.v, unit);
        const negative = kwh !== null && kwh < 0;
        const i = tIndex.get(s.t);
        if (i !== undefined)
          out[i] = negative || prevNegative ? 0 : Math.max(0, kwh ?? 0);
        prevNegative = negative;
      }
    };
    scatter(cs, chargeBind.unit, chargeKwh);
    scatter(ds, dischargeBind.unit, dischargeKwh);
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
    ? await readAgg5m(db, socBind.point, startMs, endMs)
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
