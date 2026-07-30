/**
 * Pure domain helpers for assembling energy-flow source/load series — NO database, NO UI.
 *
 * Shared by the browser matrix adapter (`lib/energy-flow-matrix.ts`) and the engine's daily flow_attr
 * rollup (`lib/db/planetscale/battery-provenance-pg.ts`) so both resolve the same canonical nodes by
 * construction.
 */

import { FlowSeries } from "./flow-matrix-core";
import { classifyEnergyStem } from "@/lib/roles/registry";

export const SOLAR_PARENT_PATH = "source.solar";
export const SOLAR_RESIDUAL_PATH = "source.solar.residual";
/**
 * The load complement — consumption no sub-meter accounts for. Usually synthesised (master − Σ
 * sub-meters, or generation − exports − sub-meters), but a vendor can METER it directly, in which
 * case a point carries this stem and the synthesis is skipped. The load-side twin of
 * {@link SOLAR_RESIDUAL_PATH}.
 */
export const REST_OF_HOUSE_PATH = "load.rest-of-house";
/**
 * EV charging. A top-level load stem in its own right — NOT under `load.` — because the vendor's
 * house-load POWER figure excludes it; see the sibling-load handling in `buildFlowSeries`. Its
 * ENERGY register is the other way round (the meter counts everything), which `attachEnergyOverlays`
 * nets out.
 */
export const EV_PATH = "ev.charge";

/**
 * Per-interval power below which a solar residual is treated as measurement noise rather than
 * real unmetered generation. Series power is in kW, so this is 20 W.
 */
export const SOLAR_RESIDUAL_EPS_KW = 0.02;

/**
 * Resolve the canonical solar SOURCE series for the energy-flow matrix.
 *
 * Vendors can expose solar as a bare total `source.solar` AND/OR per-array leaves
 * `source.solar.<leaf>` (e.g. `.local` / `.remote`). The bare total already equals the sum of
 * the leaves, so summing all of them double-counts solar. Policy (decided 2026-06-10):
 *
 *   - If leaves exist, USE THE LEAVES and, when a bare total is also present, add a synthetic
 *     `source.solar.residual` for any shortfall `max(0, total − Σ leaves)` — so displayed solar
 *     still equals the metered total without double counting. A residual that never exceeds
 *     `SOLAR_RESIDUAL_EPS_KW` is dropped as noise.
 *   - If there are no leaves, use the bare total as the single solar node.
 *   - If a bare total appears more than once, the first is used (defensive de-dup).
 *
 * Input/output identity is the canonical logical-path stem (`source.solar`,
 * `source.solar.local`, …). All series must share the same length/timebase.
 */
export function resolveSolarSources(solar: FlowSeries[]): FlowSeries[] {
  const parents = solar.filter((s) => s.path === SOLAR_PARENT_PATH);
  const leaves = solar.filter((s) =>
    s.path.startsWith(SOLAR_PARENT_PATH + "."),
  );

  if (leaves.length === 0) {
    // No leaves → the bare total IS the solar node (de-duplicated if it appears twice).
    return parents.length > 0
      ? [{ path: SOLAR_PARENT_PATH, power: parents[0].power }]
      : [];
  }

  const resolved: FlowSeries[] = leaves.map((l) => ({
    path: l.path,
    power: l.power,
  }));

  // With a known total, capture any unmetered solar as a residual leaf.
  if (parents.length > 0) {
    const parent = parents[0].power;
    const n = parent.length;
    const residual: (number | null)[] = new Array(n).fill(null);
    let hasResidual = false;
    for (let i = 0; i < n; i++) {
      const total = parent[i];
      if (total === null) continue;
      let leafSum = 0;
      for (const leaf of leaves) {
        const v = leaf.power[i];
        if (v !== null) leafSum += v;
      }
      const r = Math.max(0, total - leafSum);
      residual[i] = r;
      if (r > SOLAR_RESIDUAL_EPS_KW) hasResidual = true;
    }
    if (hasResidual) {
      resolved.push({ path: SOLAR_RESIDUAL_PATH, power: residual });
    }
  }

  return resolved;
}

/**
 * Split one signed bidirectional power series into its two non-negative directional halves.
 * Positive values flow to `positivePath`, the magnitude of negative values to `negativePath`;
 * nulls are preserved on both sides (a gap integrates nowhere). Convention (see
 * docs/architecture/energy-flow-matrix.md): battery positive = discharge (source), negative =
 * charge (load); grid positive = import (source), negative = export (load).
 */
export function splitSignedSeries(
  power: (number | null)[],
  positivePath: string,
  negativePath: string,
): { positive: FlowSeries; negative: FlowSeries } {
  const positive: (number | null)[] = new Array(power.length);
  const negative: (number | null)[] = new Array(power.length);
  for (let i = 0; i < power.length; i++) {
    const v = power[i];
    if (v === null) {
      positive[i] = null;
      negative[i] = null;
    } else {
      positive[i] = v > 0 ? v : 0;
      negative[i] = v < 0 ? -v : 0;
    }
  }
  return {
    positive: { path: positivePath, power: positive },
    negative: { path: negativePath, power: negative },
  };
}

/**
 * Apply a power point's `transform` to a signed kW value before it enters the flow matrix. Only "i"
 * (invert: ×−1) is meaningful for a power point — e.g. a grid / AC-source channel wired so that IMPORT
 * reads negative (a generator), which `splitSignedSeries`'s convention would otherwise misclassify as
 * export (a load). MUST be applied IDENTICALLY by every flow-matrix builder — the sub-daily
 * `buildFlowMatrixFromAggRows` and the engine's `recomputeFlow1dForDay` — so the 5m and materialized
 * (1d) Sankeys stay byte-identical. "d" (differentiate) is an energy-counter transform, not meaningful
 * for an instantaneous power series, so it's a no-op here.
 */
export function applyPowerTransform(
  value: number | null,
  transform: string | null,
): number | null {
  if (value === null) return null;
  return transform === "i" ? -value : value;
}

/**
 * Per-interval sum of several series. An interval is null if ANY contributor is null there —
 * matching how the browser pipeline accumulates total generation and child-load sums (a missing
 * input makes the total unknowable, not zero).
 */
export function sumSeries(arrays: (number | null)[][]): (number | null)[] {
  if (arrays.length === 0) return [];
  const n = arrays[0].length;
  const out: (number | null)[] = new Array(n);
  for (let i = 0; i < n; i++) {
    let sum = 0;
    let anyNull = false;
    for (const arr of arrays) {
      const v = arr[i];
      if (v === null) {
        anyNull = true;
        break;
      }
      sum += v;
    }
    out[i] = anyNull ? null : sum;
  }
  return out;
}

/**
 * The synthetic "rest of house" load — the consumption not covered by explicit sub-meters.
 * Faithful port of the browser's `calculateRestOfHouse` 3-case logic:
 *   1. master load + children → max(0, master − Σchildren)
 *   2. master load, no children → none (master already accounts for everything)
 *   3. no master, but generation known → max(0, generation − batteryCharge − gridExport − Σchildren)
 * All clamped ≥ 0; null where the driving input is null.
 */
export function computeRestOfHouse(
  masterLoad: (number | null)[] | null,
  childLoadsSum: (number | null)[] | null,
  batteryCharge: (number | null)[] | null,
  gridExport: (number | null)[] | null,
  totalGeneration: (number | null)[] | null,
): (number | null)[] | null {
  if (masterLoad !== null && childLoadsSum !== null) {
    return masterLoad.map((m, i) => {
      const c = childLoadsSum[i];
      if (m === null || c === null) return null;
      return Math.max(0, m - c);
    });
  }
  if (masterLoad !== null && childLoadsSum === null) return null;
  if (masterLoad === null && totalGeneration !== null) {
    return totalGeneration.map((g, i) => {
      if (g === null) return null;
      const c = (childLoadsSum && childLoadsSum[i]) || 0;
      const bc = (batteryCharge && batteryCharge[i]) || 0;
      const ge = (gridExport && gridExport[i]) || 0;
      return Math.max(0, g - bc - ge - c);
    });
  }
  return null;
}

/** A point classified by its canonical logical-path stem, with power in kW on a shared timebase. */
export interface ClassifiedPoint {
  /** e.g. "source.solar.local", "bidi.battery", "bidi.grid", "load", "load.hws". */
  stem: string;
  power: (number | null)[];
}

/**
 * An energy-accumulator point's exact interval energies (kWh), aligned to the shared timeline by
 * SLOT: `energyKwhBySlot[i]` is the `agg_5m.delta` stamped at `timeline[i]` — the metered energy
 * over `(timeline[i-1], timeline[i]]`. The slot→interval shift (interval i = delta at slot i+1)
 * happens ONCE, inside {@link buildFlowSeries}'s attach step — loaders only scatter by interval_end.
 */
export interface EnergySeriesInput {
  /** The energy point's logical-path stem, e.g. "bidi.battery.charge", "load", "bidi.grid". */
  stem: string;
  energyKwhBySlot: (number | null)[];
}

/**
 * Apply an energy point's `transform` to a signed interval-kWh value before it enters the flow
 * matrix. Only "i" (invert: ×−1) is meaningful — a NET accumulator wired so import/discharge reads
 * negative. "d" (differentiate) already happened upstream in the 5m aggregation (`delta` IS the
 * differenced value), so it's a no-op here. The single home for the rule, mirroring
 * {@link applyPowerTransform}.
 */
export function applyEnergyTransform(
  value: number | null,
  transform: string | null,
): number | null {
  if (value === null) return null;
  return transform === "i" ? -value : value;
}

/** Convert an `agg_5m.delta` value to interval kWh given the point's metric unit (Wh → /1000). */
export function toIntervalKwh(
  value: number | null,
  unit: string | null,
): number | null {
  if (value === null) return null;
  return unit === "Wh" ? value / 1000 : value;
}

/**
 * Assemble the canonical source/load `FlowSeries` for the energy-flow matrix from a device's
 * power points (each as signed kW on a shared timebase). This is the engine-side equivalent of
 * the browser's split / solar-aggregation / rest-of-house pipeline, kept pure so the two paths
 * resolve the same nodes:
 *
 *  - solar  → `resolveSolarSources` (leaves + residual, or bare total)
 *  - battery `bidi.battery` → source.battery (discharge) + load.battery (charge)
 *  - grid    `bidi.grid`    → source.grid (import) + load.grid (export)
 *  - loads   `load` (master) and `load.<sub>` (children) pass through
 *  - `load.rest-of-house` is derived from the 3-case rule
 */
export function buildFlowSeries(
  points: ClassifiedPoint[],
  energySeries?: EnergySeriesInput[],
  /** Shared slot timeline (epoch ms) — only needed to net sibling loads out of a master-`load`
   *  energy register (see `attachEnergyOverlays`); omit and that netting falls back to power. */
  timeline?: number[],
): {
  sources: FlowSeries[];
  loads: FlowSeries[];
} {
  const solarInput: FlowSeries[] = [];
  let batteryPower: (number | null)[] | null = null;
  let gridPower: (number | null)[] | null = null;
  let masterLoad: (number | null)[] | null = null;
  const childLoads: FlowSeries[] = [];

  for (const p of points) {
    if (
      p.stem === SOLAR_PARENT_PATH ||
      p.stem.startsWith(SOLAR_PARENT_PATH + ".")
    ) {
      solarInput.push({ path: p.stem, power: p.power });
    } else if (p.stem === "bidi.battery") {
      batteryPower = p.power;
    } else if (p.stem === "bidi.grid") {
      gridPower = p.power;
    } else if (p.stem === "load") {
      masterLoad = p.power;
    } else if (p.stem.startsWith("load.")) {
      childLoads.push({ path: p.stem, power: p.power });
    }
    // `ev.charge` is NOT a sink. An EV charger participates in the flow matrix as `load.ev` — a
    // child of the load hierarchy like any other sub-meter. A point stemmed `ev.charge` is the
    // VEHICLE's own view of the same energy (Tesla), which either duplicates a `load.ev` circuit
    // (Kinkora metered both: 42.7 vs 33.3 kWh in one week) or sits inside the site meter (Sigenergy)
    // — either way, counting it as a sink double-counts. It stays a first-class point for cards and
    // charts; it just isn't a node.
  }

  const sources: FlowSeries[] = [...resolveSolarSources(solarInput)];
  const loads: FlowSeries[] = [];

  let batteryCharge: (number | null)[] | null = null;
  if (batteryPower !== null) {
    const { positive, negative } = splitSignedSeries(
      batteryPower,
      "source.battery",
      "load.battery",
    );
    sources.push(positive);
    loads.push(negative);
    batteryCharge = negative.power;
  }

  let gridExport: (number | null)[] | null = null;
  if (gridPower !== null) {
    const { positive, negative } = splitSignedSeries(
      gridPower,
      "source.grid",
      "load.grid",
    );
    sources.push(positive);
    loads.push(negative);
    gridExport = negative.power;
  }

  // `load` is a strict HIERARCHY, exactly like `source.solar`: the master is the TOTAL and its
  // `load.<sub>` children are metered subsets of it. So the master is a sink only when it has no
  // children; with children it becomes a BUDGET and the sinks are the children plus the COMPLEMENT
  // (`load.rest-of-house`) — the load no sub-meter covers. Pushing both the master and its children
  // would count the metered circuits twice.
  //
  // The complement is normally synthesised, but a vendor may METER it (Sigenergy's `loadPower` is
  // house-excluding-charger, which is exactly this quantity). One node either way: a measured
  // complement is used as-is and nothing is synthesised on top of it, and it is NOT one of the
  // children the master is reduced by — it IS the remainder.
  const measuredComplement =
    childLoads.find((c) => c.path === REST_OF_HOUSE_PATH) ?? null;
  const subMeters = childLoads.filter((c) => c.path !== REST_OF_HOUSE_PATH);
  const hasChildren = childLoads.length > 0;
  if (masterLoad !== null && !hasChildren)
    loads.push({ path: "load", power: masterLoad });
  for (const c of childLoads) loads.push(c);

  if (measuredComplement === null) {
    const subMeterSum =
      subMeters.length > 0 ? sumSeries(subMeters.map((c) => c.power)) : null;
    const totalGen =
      sources.length > 0 ? sumSeries(sources.map((s) => s.power)) : null;
    const restOfHouse = computeRestOfHouse(
      masterLoad,
      subMeterSum,
      batteryCharge,
      gridExport,
      totalGen,
    );
    if (restOfHouse !== null) {
      loads.push({ path: REST_OF_HOUSE_PATH, power: restOfHouse });
    }
  }

  if (energySeries && energySeries.length > 0) {
    attachEnergyOverlays(sources, loads, energySeries, subMeters, timeline);
  }

  return { sources, loads };
}

/**
 * Attach exact-energy overlays (`FlowSeries.energyKwh`) to the flow nodes the power points created.
 * Energy points DECORATE existing nodes — they never create them (an accumulator with no power
 * sibling attaches nowhere; no current vendor is in that state). Per {@link classifyEnergyStem}:
 *
 *  - `pair`: the register's interval energy lands on its directional node — BOTH halves of a bidi
 *    channel can be nonzero in the same interval, preserving the gross flow the signed power
 *    average nets away. Negative deltas (a counter reset) are defensively nulled.
 *  - `net`:  the signed exact net splits by sign onto the channel's two halves (exact net, still
 *    gross-lossy — the meter already destroyed intra-interval reversals).
 *  - `uni`:  attaches straight onto the same-path node (clamped like `pair`).
 *
 * Multiple registers targeting one node (multi-device areas, Amber `.controlled` + `.import`) sum
 * with null-poisoning — if ANY contributor is missing an interval the node's overlay is null there
 * and that interval falls back to power integration, matching `sumSeries`' "a missing input makes
 * the total unknowable" rule. Derived nodes (`load.rest-of-house`, `source.solar.residual`) are
 * power-only by construction and never receive an overlay.
 *
 * This is also the single home of the slot→interval SHIFT: inputs are keyed by timeline SLOT (the
 * delta stamped at `timeline[i]` covers `(timeline[i-1], timeline[i]]`), while `energyKwh[i]`
 * means interval `(timeline[i], timeline[i+1]]` — so interval i reads slot i+1.
 */
function attachEnergyOverlays(
  sources: FlowSeries[],
  loads: FlowSeries[],
  energySeries: EnergySeriesInput[],
  /** The metered sub-loads — NOT including the complement, which is what the master reduces TO. */
  subMeters: FlowSeries[] = [],
  timeline?: number[],
): void {
  const n = energySeries[0]?.energyKwhBySlot.length ?? 0;
  const intervals = Math.max(0, n - 1);
  // Accumulate per target path with null-poisoning across contributors.
  const byPath = new Map<string, (number | null)[]>();
  const addContribution = (
    path: string,
    valueAt: (slot: number) => number | null,
  ): void => {
    let acc = byPath.get(path);
    if (!acc) {
      acc = new Array<number | null>(intervals).fill(null);
      byPath.set(path, acc);
      for (let i = 0; i < intervals; i++) acc[i] = valueAt(i + 1);
      return;
    }
    for (let i = 0; i < intervals; i++) {
      const v = valueAt(i + 1);
      const prev = acc[i];
      acc[i] = prev === null || v === null ? null : prev + v;
    }
  };

  for (const e of energySeries) {
    const cls = classifyEnergyStem(e.stem);
    if (cls === null) continue;
    const slots = e.energyKwhBySlot;
    if (cls.kind === "pair" || cls.kind === "uni") {
      addContribution(cls.targetPath, (slot) => {
        const v = slots[slot];
        if (v === null || v === undefined) return null;
        // A counter re-base shows up as a MATCHED PAIR: one negative delta (the counter dropping to
        // its new base) immediately followed by a catch-up delta carrying everything the counter had
        // accumulated. Raw sums self-cancel; nulling only the negative half would keep the catch-up
        // and count that history twice (measured on Sigenergy: −27.3 kWh then +29.3 kWh in adjacent
        // 5-min slots, inflating the day's load/charge/solar to ~2×). Both halves are unknown — the
        // intervals fall back to power integration.
        if (v < 0) return null;
        const prev = slots[slot - 1];
        if (prev !== null && prev !== undefined && prev < 0) return null;
        return v;
      });
    } else {
      // net: split the signed exact net by sign onto the channel's directional halves.
      const positivePath =
        cls.channelStem === "bidi.battery" ? "source.battery" : "source.grid";
      const negativePath =
        cls.channelStem === "bidi.battery" ? "load.battery" : "load.grid";
      addContribution(positivePath, (slot) => {
        const v = slots[slot];
        if (v === null || v === undefined) return null;
        return v > 0 ? v : 0;
      });
      addContribution(negativePath, (slot) => {
        const v = slots[slot];
        if (v === null || v === undefined) return null;
        return v < 0 ? -v : 0;
      });
    }
  }

  // The master-`load` register is the site TOTAL. With sub-meters present there is no `load` node to
  // decorate (buildFlowSeries made the master a budget), so the register lands where it belongs: on
  // the COMPLEMENT, `load.rest-of-house` = total − Σ sub-meters. The complement is the one node
  // defined as "whatever the sub-meters don't cover", so the exact total is what sizes it — whether
  // that node was synthesised or measured (a measured one keeps its power series for shape and gains
  // the exact energy). The sink side then sums to the metered total instead of the register being
  // discarded for want of a node with a matching path.
  // A sub-meter's energy is its own overlay where it has one, else the same trapezoid
  // `computeFlowAccounting` would use; unknown ⇒ the complement's interval falls back to power.
  const masterOverlay = byPath.get("load");
  const hasLoadNode = loads.some((l) => l.path === "load");
  const complement = loads.find((l) => l.path === REST_OF_HOUSE_PATH);
  if (masterOverlay && !hasLoadNode && complement) {
    const exact = new Array<number | null>(intervals).fill(null);
    for (let i = 0; i < intervals; i++) {
      if (masterOverlay[i] === null) continue;
      let net: number | null = masterOverlay[i]!;
      for (const child of subMeters) {
        const childOverlay = byPath.get(child.path);
        let e = childOverlay ? childOverlay[i] : null;
        if (e === null && timeline !== undefined) {
          const p1 = child.power[i];
          const p2 = child.power[i + 1];
          const dtH = (timeline[i + 1] - timeline[i]) / 3_600_000;
          if (p1 !== null && p2 !== null) e = ((p1 + p2) / 2) * dtH;
        }
        if (e === null) {
          net = null;
          break;
        }
        net -= e;
      }
      exact[i] = net === null ? null : Math.max(0, net);
    }
    byPath.set(REST_OF_HOUSE_PATH, exact);
    byPath.delete("load");
  }

  for (const node of [...sources, ...loads]) {
    const overlay = byPath.get(node.path);
    if (overlay) node.energyKwh = overlay;
  }
}
