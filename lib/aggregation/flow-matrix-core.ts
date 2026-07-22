/**
 * Pure energy-flow matrix integrator — NO database, NO UI, NO domain knowledge.
 *
 * Given source and load POWER series sampled at shared timestamps, it integrates each
 * load's energy per interval (trapezoidal rule) and allocates that energy across sources
 * in proportion to each source's instantaneous share of total generation, accumulating
 * into cumulative kWh.
 *
 * Two properties this module is built around:
 *  1. Energy is ADDITIVE across intervals — so the matrix of a concatenated window equals
 *     the element-wise SUM of the matrices of its sub-windows. This is what makes a monthly
 *     flow matrix a plain sum of daily flow matrices.
 *  2. Direction must already be resolved in the INPUTS — battery charge / grid export are
 *     supplied as separate non-negative LOAD series, discharge / import as non-negative
 *     SOURCE series. Splitting a signed bidirectional series and computing rest-of-house are
 *     domain concerns owned by the callers, not this integrator.
 *
 * Shared by the browser adapter (`lib/energy-flow-matrix.ts`) and the engine's daily flow_attr rollup
 * (`lib/db/planetscale/battery-provenance-pg.ts`) so both compute identical values by construction —
 * the same discipline as `lib/aggregation/point-aggregates.ts`.
 */

export interface FlowSeries {
  /** Stable canonical identity, e.g. "source.solar" | "load.rest-of-house". */
  path: string;
  /** Power at each timestamp (same length/order as `timestamps`); null = no datum. */
  power: (number | null)[];
}

export interface FlowMatrixResult {
  sources: string[]; // source paths, in input order
  loads: string[]; // load paths, in input order
  matrix: number[][]; // [sourceIdx][loadIdx] = cumulative energy (kWh), always >= 0
  sourceTotals: number[]; // row sums
  loadTotals: number[]; // column sums
  totalEnergy: number; // grand total
  intervalsUsed: number; // # of intervals that contributed energy (coverage signal)
}

/**
 * Per-source, per-interval intensity series (index-aligned to `sources` and `timestamps`; null = unknown).
 * Solar carries {0, 1, solarCost}; grid the OE/Amber series; the battery the provenance fold's blend.
 *
 * `selfRenewable` is the JOINT attribute (behind-the-meter AND renewable) — the single place it is
 * defined per source: solar = 1.0 (our own renewable generation), grid = 0.0 (grid renewables are not
 * behind the meter), off-grid/backup generator = 0.0 (carried as `source.grid` — self-origin but NOT
 * renewable), battery = the fold's self-renewable blend (Qsr/E), other = null (unknown). It is NOT a
 * product of `renewable` × anything: the two attributes are correlated inside the battery (solar charge
 * is both, grid charge is renewable-only), so it needs its own stock and column.
 */
export interface SourceIntensity {
  emissions: (number | null)[]; // gCO2 per kWh
  renewable: (number | null)[]; // renewable fraction 0..1
  price: (number | null)[]; // cents per kWh (may be negative)
  /** Joint behind-the-meter-AND-renewable fraction 0..1; null = unknown (see interface doc). */
  selfRenewable: (number | null)[];
  estimated: boolean[]; // true where this source's intensity is provisional/estimated
}

/** The full flow accounting: energy per edge (the Sankey), plus the attributed metric legs. */
export interface FlowAccountingResult {
  sources: string[];
  loads: string[];
  /** [s][l] energy (kWh) — the flow matrix / Sankey energy leg. */
  energyKwh: number[][];
  /** [s][l] attributed emissions (gCO2), over intervals with a known emissions intensity. */
  emissionsG: number[][];
  /** [s][l] attributed renewable energy (kWh), over intervals with a known renewable fraction. */
  renewableKwh: number[][];
  /** [s][l] attributed SELF-renewable energy (kWh) — behind-the-meter AND renewable — over intervals
   *  with a known self-renewable fraction. The joint attribute powering renewable-autarky / own-renewable
   *  self-consumption; never derivable from `renewableKwh`. */
  selfRenewableKwh: number[][];
  /** [s][l] attributed cost (cents), over intervals with a known price. */
  costC: number[][];
  /** [s][l] energy (kWh) whose source intensity was estimated OR unknown (confidence denominator). */
  estimatedKwh: number[][];
  /** [s][l] energy (kWh) with a known emissions intensity — the unbiased-average denominator. */
  emissionsKnownKwh: number[][];
  /** [s][l] energy (kWh) with a known renewable fraction. */
  renewableKnownKwh: number[][];
  /** [s][l] energy (kWh) with a known self-renewable fraction — the unbiased-average denominator. */
  selfRenewableKnownKwh: number[][];
  /** [s][l] energy (kWh) with a known price. */
  priceKnownKwh: number[][];
  /** # of intervals that contributed energy (coverage signal). */
  intervalsUsed: number;
}

function zeros(rows: number, cols: number): number[][] {
  return Array.from({ length: rows }, () => new Array<number>(cols).fill(0));
}

/**
 * The channel identity of a source/load path — everything after the leading "source."/"load."
 * segment. Two nodes with the same channel id are the split halves of one signed bidirectional
 * series (`splitSignedSeries`, e.g. "source.battery"/"load.battery", "source.grid"/"load.grid") —
 * physically the same meter, so energy can never flow from one to the other (a battery can't charge
 * itself). Pure string convention, no lookup table — works for any current or future bidi role.
 */
function channelId(path: string): string {
  const dot = path.indexOf(".");
  return dot === -1 ? path : path.slice(dot + 1);
}

/**
 * For each load, the index of its linked source (same channel id, e.g. load.battery ↔
 * source.battery) — or -1 if the load has none (a plain load like `load` or `load.hws`).
 */
function linkedSourceIndices(
  sources: FlowSeries[],
  loads: FlowSeries[],
): number[] {
  return loads.map((load) => {
    const channel = channelId(load.path);
    return sources.findIndex((s) => channelId(s.path) === channel);
  });
}

/**
 * The unified flow-accounting integrator — the single allocation loop this module is built around. It
 * integrates each load's trapezoidal energy and allocates it across sources by each source's share of
 * generation (left-endpoint), accumulating ENERGY per edge. When `sourceIntensities` is supplied it ALSO
 * decorates every contribution with that source's per-interval emissions / renewable / cost, so the
 * "metric legs" fall out of the SAME allocation as the energy leg — no second loop to drift.
 *
 * `computeFlowMatrix` is the ENERGY PROJECTION of this (Sankey = the energy leg). A null intensity for an
 * interval leaves that contribution out of the attributed sum but counts its energy in `estimatedKwh`; the
 * `*KnownKwh` denominators give an unbiased average intensity (`emissionsG / emissionsKnownKwh`).
 * Intensities are read at the interval's LEFT endpoint (index i), matching the proportion endpoint.
 */
export function computeFlowAccounting(input: {
  timestamps: number[];
  sources: FlowSeries[];
  loads: FlowSeries[];
  /** Index-aligned to `sources`; omit for the energy-only path. A null entry = a source with no intensity. */
  sourceIntensities?: (SourceIntensity | null)[];
  /**
   * Optional attribution window (epoch-ms): accumulate ONLY intervals that lie ENTIRELY within the
   * window — start `timestamps[i] >= startMs` AND end `timestamps[i+1] <= endMs`. Used to slice a single
   * local DAY out of a longer loaded/folded window for the per-day rollup, while the caller's fold ran
   * over the whole window for anchoring. Requiring the WHOLE interval (not just its end) to fall inside
   * makes the per-day slice byte-identical to integrating that day's samples in isolation (the legacy
   * `flow_1d` recompute), so a gap-/midnight-spanning interval is NOT attributed wholly to the later day.
   * Omit = all intervals.
   */
  window?: { startMs: number; endMs: number };
}): FlowAccountingResult {
  const { timestamps, sources, loads, sourceIntensities, window } = input;
  const S = sources.length;
  const L = loads.length;
  const withMetrics = sourceIntensities !== undefined;

  const energyKwh = zeros(S, L);
  const emissionsG = zeros(S, L);
  const renewableKwh = zeros(S, L);
  const selfRenewableKwh = zeros(S, L);
  const costC = zeros(S, L);
  const estimatedKwh = zeros(S, L);
  const emissionsKnownKwh = zeros(S, L);
  const renewableKnownKwh = zeros(S, L);
  const selfRenewableKnownKwh = zeros(S, L);
  const priceKnownKwh = zeros(S, L);
  let intervalsUsed = 0;

  // A load never draws from its own linked source (see `channelId`) — a battery can't charge
  // itself, a grid connection can't export to its own import. Precomputed once; index-aligned to
  // `loads`, -1 = this load has no linked source (the common case).
  const linkedSource = linkedSourceIndices(sources, loads);

  for (let i = 0; i < timestamps.length - 1; i++) {
    // Attribution window: integrate interval i only if it lies ENTIRELY inside the window — its start
    // >= startMs AND its end <= endMs. A cross-boundary interval (start before the window, e.g. spanning
    // a data gap or midnight) belongs to the prior day and is dropped here, matching the isolated
    // per-day integration of the legacy `flow_1d` recompute.
    if (
      window &&
      (timestamps[i] < window.startMs || timestamps[i + 1] > window.endMs)
    ) {
      continue;
    }
    const deltaHours = (timestamps[i + 1] - timestamps[i]) / (1000 * 60 * 60);

    let totalGenPower = 0;
    for (const source of sources) {
      const power = source.power[i];
      if (power !== null) totalGenPower += power;
    }
    if (totalGenPower <= 0) continue;

    let contributed = false;
    for (let l = 0; l < L; l++) {
      const loadPower1 = loads[l].power[i];
      const loadPower2 = loads[l].power[i + 1];
      if (loadPower1 === null || loadPower2 === null) continue;

      const loadIntervalEnergy = ((loadPower1 + loadPower2) / 2) * deltaHours;
      if (loadIntervalEnergy === 0) continue;

      // Exclude this load's own linked source from the pool it draws from (see `linkedSource`
      // above), so a mid-interval charge/discharge (or import/export) polarity flip can never
      // allocate energy from a source to its own paired load — the trapezoidal load integral and
      // the left-endpoint source proportion would otherwise disagree exactly at the flip sample.
      const excludeIdx = linkedSource[l];
      let genPowerForLoad = totalGenPower;
      if (excludeIdx >= 0) {
        const excludedPower = sources[excludeIdx].power[i];
        if (excludedPower !== null) genPowerForLoad -= excludedPower;
      }
      if (genPowerForLoad <= 0) continue; // nothing valid left to attribute this load's energy to

      for (let s = 0; s < S; s++) {
        if (s === excludeIdx) continue;
        const power1 = sources[s].power[i];
        const power2 = sources[s].power[i + 1];
        if (power1 === null || power2 === null) continue;

        const sourceProportion = power1 / genPowerForLoad;
        const contribution = loadIntervalEnergy * sourceProportion;
        energyKwh[s][l] += contribution;
        if (contribution === 0) continue;
        contributed = true;

        if (withMetrics) {
          const si = sourceIntensities![s] ?? null;
          const ei = si ? si.emissions[i] : null;
          const rf = si ? si.renewable[i] : null;
          // `selfRenewable` is optional on older SourceIntensity producers; guard so its absence reads
          // as "unknown" (null) rather than throwing — it never perturbs the energy or other metric legs.
          const sr = si && si.selfRenewable ? si.selfRenewable[i] : null;
          const pr = si ? si.price[i] : null;
          const est = si ? si.estimated[i] === true : true;

          if (ei !== null) {
            emissionsG[s][l] += contribution * ei;
            emissionsKnownKwh[s][l] += contribution;
          }
          if (rf !== null) {
            renewableKwh[s][l] += contribution * rf;
            renewableKnownKwh[s][l] += contribution;
          }
          if (sr !== null) {
            selfRenewableKwh[s][l] += contribution * sr;
            selfRenewableKnownKwh[s][l] += contribution;
          }
          if (pr !== null) {
            costC[s][l] += contribution * pr;
            priceKnownKwh[s][l] += contribution;
          }
          if (est || ei === null || rf === null || pr === null) {
            estimatedKwh[s][l] += contribution;
          }
        }
      }
    }
    if (contributed) intervalsUsed++;
  }

  return {
    sources: sources.map((s) => s.path),
    loads: loads.map((l) => l.path),
    energyKwh,
    emissionsG,
    renewableKwh,
    selfRenewableKwh,
    costC,
    estimatedKwh,
    emissionsKnownKwh,
    renewableKnownKwh,
    selfRenewableKnownKwh,
    priceKnownKwh,
    intervalsUsed,
  };
}

/**
 * Integrate a source→load energy-flow matrix from instantaneous power series.
 *
 * Requires at least one source and one load. With fewer than two timestamps the integration
 * loop simply doesn't run and a zero matrix is returned (matching the previous behaviour).
 *
 * The allocation deliberately uses the LEFT endpoint power for the source proportion while
 * integrating the load energy trapezoidally — this is the long-standing behaviour and is kept
 * byte-identical here; at 5-minute resolution the difference is negligible. (Tracked as a
 * latent inconsistency to revisit with its own behaviour-changing test.)
 */
export function computeFlowMatrix(input: {
  timestamps: number[]; // epoch ms, ascending; one per power sample
  sources: FlowSeries[];
  loads: FlowSeries[];
}): FlowMatrixResult {
  // The Sankey is the ENERGY projection of the unified flow accounting (no intensities → energy only).
  const r = computeFlowAccounting(input);
  const matrix = r.energyKwh;
  const sourceTotals = matrix.map((row) => row.reduce((sum, v) => sum + v, 0));
  const loadTotals = new Array<number>(r.loads.length).fill(0);
  for (let l = 0; l < r.loads.length; l++) {
    for (let s = 0; s < r.sources.length; s++) {
      loadTotals[l] += matrix[s][l];
    }
  }
  const totalEnergy = sourceTotals.reduce((sum, v) => sum + v, 0);

  return {
    sources: r.sources,
    loads: r.loads,
    matrix,
    sourceTotals,
    loadTotals,
    totalEnergy,
    intervalsUsed: r.intervalsUsed,
  };
}

/**
 * Snapshot of the source→load flow at a SINGLE sample (no integration). At the given `index` it
 * allocates each load's instantaneous value across sources in proportion to each source's share of
 * total generation at that same sample — the same proportional rule {@link computeFlowMatrix} uses
 * per interval, but on the raw sample value rather than trapezoidal energy.
 *
 * The unit of the result is the unit of the input series at that sample: POWER (kW) for the 5m/30m
 * (1D/7D) charts. (The 30D Sankey hover does NOT use this — it indexes a real per-day energy matrix
 * from `flow_1d`.) Same `FlowMatrixResult` shape, with row/column sums for the node totals, so it
 * drops straight into the same sankey renderer.
 */
export function computeInstantFlowMatrix(input: {
  sources: FlowSeries[];
  loads: FlowSeries[];
  index: number;
}): FlowMatrixResult {
  const { sources, loads, index } = input;

  const matrix: number[][] = Array.from({ length: sources.length }, () =>
    new Array<number>(loads.length).fill(0),
  );
  let intervalsUsed = 0;

  let totalGenPower = 0;
  for (const source of sources) {
    const power = source.power[index];
    if (power !== null && power !== undefined) totalGenPower += power;
  }

  // Same "a load never draws from its own linked source" rule as `computeFlowAccounting` (see
  // `channelId`) — at a single sample this is structurally already impossible (a signed series'
  // split halves can't both be nonzero at once), but enforced here too for defense-in-depth and to
  // keep the invariant visible in both functions.
  const linkedSource = linkedSourceIndices(sources, loads);

  if (totalGenPower > 0) {
    let contributed = false;
    for (let l = 0; l < loads.length; l++) {
      const loadPower = loads[l].power[index];
      if (loadPower === null || loadPower === undefined) continue;

      const excludeIdx = linkedSource[l];
      let genPowerForLoad = totalGenPower;
      if (excludeIdx >= 0) {
        const excludedPower = sources[excludeIdx].power[index];
        if (excludedPower !== null && excludedPower !== undefined)
          genPowerForLoad -= excludedPower;
      }
      if (genPowerForLoad <= 0) continue;

      for (let s = 0; s < sources.length; s++) {
        if (s === excludeIdx) continue;
        const sourcePower = sources[s].power[index];
        if (sourcePower === null || sourcePower === undefined) continue;
        const sourceProportion = sourcePower / genPowerForLoad;
        const contribution = loadPower * sourceProportion;
        matrix[s][l] += contribution;
        if (contribution !== 0) contributed = true;
      }
    }
    if (contributed) intervalsUsed = 1;
  }

  const sourceTotals = matrix.map((row) => row.reduce((sum, v) => sum + v, 0));
  const loadTotals = new Array<number>(loads.length).fill(0);
  for (let l = 0; l < loads.length; l++) {
    for (let s = 0; s < sources.length; s++) {
      loadTotals[l] += matrix[s][l];
    }
  }
  const totalEnergy = sourceTotals.reduce((sum, v) => sum + v, 0);

  return {
    sources: sources.map((s) => s.path),
    loads: loads.map((l) => l.path),
    matrix,
    sourceTotals,
    loadTotals,
    totalEnergy,
    intervalsUsed,
  };
}
