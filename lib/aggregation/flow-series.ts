/**
 * Pure domain helpers for assembling energy-flow source/load series — NO database, NO UI.
 *
 * Shared by the browser matrix adapter (`lib/energy-flow-matrix.ts`) and the engine's daily flow_attr
 * rollup (`lib/db/planetscale/battery-provenance-pg.ts`) so both resolve the same canonical nodes by
 * construction.
 */

import { FlowSeries } from "./flow-matrix-core";

export const SOLAR_PARENT_PATH = "source.solar";
export const SOLAR_RESIDUAL_PATH = "source.solar.residual";

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
 * Assemble the canonical source/load `FlowSeries` for the energy-flow matrix from a system's
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
export function buildFlowSeries(points: ClassifiedPoint[]): {
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

  if (masterLoad !== null) loads.push({ path: "load", power: masterLoad });
  for (const c of childLoads) loads.push(c);

  const childSum =
    childLoads.length > 0 ? sumSeries(childLoads.map((c) => c.power)) : null;
  const totalGen =
    sources.length > 0 ? sumSeries(sources.map((s) => s.power)) : null;
  const restOfHouse = computeRestOfHouse(
    masterLoad,
    childSum,
    batteryCharge,
    gridExport,
    totalGen,
  );
  if (restOfHouse !== null) {
    loads.push({ path: "load.rest-of-house", power: restOfHouse });
  }

  return { sources, loads };
}
