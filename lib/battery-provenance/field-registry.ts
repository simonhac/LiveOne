/**
 * Battery-provenance daily field/series registry — the single source of truth for the history
 * panel (`components/battery-provenance/`): field labels/units/descriptions, the chart grouping,
 * series styling, and the API response shape all live HERE so the route, query factory, charts,
 * value table, and tooltips can never disagree.
 *
 * Client-safe: imports only TYPES from the schema (erased at compile time — no drizzle runtime).
 *
 * `FIELD_META satisfies Record<ProvenanceFieldKey, …>` is the checkpoint.ts trick: adding,
 * removing, or renaming a `battery_provenance_daily` column is a compile error here, forcing the
 * registry (and therefore the panel) to be updated in the same change.
 */
import type { BatteryProvenanceDailyRow } from "@/lib/db/planetscale/schema";

// ── Field keys ──────────────────────────────────────────────────────────────────────────────────

/** Row columns that are NOT per-day chartable scalars (keys, blobs, bookkeeping). */
type ExcludedRowKey =
  | "areaId"
  | "day"
  | "firstIntervalEnd"
  | "foldState"
  | "version"
  | "createdAt"
  | "updatedAt";

/** Chartable scalar columns of battery_provenance_daily (booleans serialize as 0|1). */
export type PlottableRowKey = Exclude<
  keyof BatteryProvenanceDailyRow,
  ExcludedRowKey
>;

/** Scalars the API extracts from the `fold_state` checkpoint envelope (state at day START). */
export type FoldDerivedKey =
  | "foldStoredKwh"
  | "foldEstimatedKwh"
  | "foldRenewableKwh"
  | "foldCarbonG"
  | "foldCostC"
  | "foldCostOppC";

/** Every key of the API's `fields` map. */
export type ProvenanceFieldKey = PlottableRowKey | FoldDerivedKey;

// ── API response shape (route + query factory + panel all import this) ─────────────────────────

export interface ProvenanceDailyResponse {
  areaId: string;
  /** The area's integer handle (legacySystemId), null for an unhandled area. */
  systemId: number | null;
  /** Resolved + clamped window, area-local YYYY-MM-DD inclusive. */
  range: { start: string; end: string };
  /** DENSE calendar sequence start..end — absent DB rows are null in every field. */
  days: string[];
  /** Parallel to `days`. `recal` is 0|1; fold-derived keys are null when the envelope is absent/invalid. */
  fields: Record<ProvenanceFieldKey, (number | null)[]>;
  /** Table-only bookkeeping, parallel to `days`. */
  rowMeta: {
    firstIntervalEnd: (string | null)[];
    version: (number | null)[];
    updatedAt: (string | null)[];
  };
}

// ── Field metadata ──────────────────────────────────────────────────────────────────────────────

export interface ProvenanceFieldMeta {
  label: string;
  unit: string;
  decimals: number;
  /** Tooltip text: what the variable tracks and how the algorithm uses it. */
  description: string;
}

export const FIELD_META = {
  intervalCount: {
    label: "Intervals",
    unit: "",
    decimals: 0,
    description:
      "Number of 5-minute slots present in the day (max 288). A pure data-density diagnostic — a partial or gappy day reads well below 288. It does not feed any fit.",
  },
  chargeKwh: {
    label: "Charge",
    unit: "kWh",
    decimals: 2,
    description:
      "Ungated sum of energy charged into the battery across the day, reduced once from agg_5m. Input to the η estimator (η = Σdischarge/Σcharge) and the three-term loss regression. “Ungated” = every slot counts, unlike the rail-gated capacity-fit sums.",
  },
  dischargeKwh: {
    label: "Discharge",
    unit: "kWh",
    decimals: 2,
    description:
      "Ungated sum of energy discharged from the battery across the day. Numerator of the daily round-trip efficiency estimate and a term in the loss regression.",
  },
  capDischargeKwh: {
    label: "Cap-fit discharge",
    unit: "kWh",
    decimals: 2,
    description:
      "Discharge summed only over consecutive-slot pairs where both SoCs are known and below the 98% rail. Numerator of the capacity slope C ≈ 100·Σcap_discharge/Σdown_swing; additive across days so windowed fits sum cleanly.",
  },
  probeChargeKwh: {
    label: "Probe charge",
    unit: "kWh",
    decimals: 2,
    description:
      "Invalidation-probe baseline: the charge energy-register delta agg_1d reported when this day was last reduced. If live agg_1d later disagrees by more than 0.02 kWh the day is re-reduced — visible divergence from Charge means the probe fired.",
  },
  probeDischargeKwh: {
    label: "Probe discharge",
    unit: "kWh",
    decimals: 2,
    description:
      "Invalidation-probe baseline for the discharge register (see Probe charge). Null when the area has no bound energy registers — the probe is inapplicable.",
  },
  netAfterSocKwh: {
    label: "Net after SoC obs",
    unit: "kWh",
    decimals: 2,
    description:
      "Seam state: signed Σ(charge − discharge) accumulated since the day's last SoC observation. The recal detector compares this metered net against the SoC-implied energy change to spot BMS re-anchors, even across SoC-dark days.",
  },
  socFirst: {
    label: "SoC first",
    unit: "%",
    decimals: 1,
    description:
      "First non-null forward-filled SoC in the day. With SoC last it brackets the day's ΔSoC, whose implied energy (ΔSoC·C/100) anchors the charge-efficiency / idle-loss regression.",
  },
  socLast: {
    label: "SoC last",
    unit: "%",
    decimals: 1,
    description:
      "Last non-null forward-filled SoC in the day — the other end of the ΔSoC bracket used by the loss regression.",
  },
  socMin: {
    label: "SoC min",
    unit: "%",
    decimals: 1,
    description:
      "Minimum non-null forward-filled SoC in the day — the sole input to the reserve-floor learner, which takes a low (5th-percentile) quantile of the trailing 90 per-day minima.",
  },
  socSamples: {
    label: "SoC samples",
    unit: "",
    decimals: 0,
    description:
      "Count of 5-minute intervals with a non-null SoC (0–288). The loss fit trusts a day's ΔSoC only when ≥200 intervals are covered; zero coverage across history marks the battery SoC-blind, disabling the capacity/loss/reserve learners entirely.",
  },
  downSwingPct: {
    label: "Down-swing",
    unit: "pp",
    decimals: 1,
    description:
      "Rail-gated sum of downward SoC steps across the day (SoC percentage points) — the denominator of the capacity slope. Can reach into the hundreds on a high-cycling day.",
  },
  recal: {
    label: "Recal day",
    unit: "",
    decimals: 0,
    description:
      "BMS-recalibration day: SoC-implied energy diverged from the metered net by more than the threshold (~2 kWh), meaning the BMS re-anchored its SoC estimate. Recal days are excluded from every fit and shown as amber bands on the diagnostics chart.",
  },
  socLastSlotPct: {
    label: "SoC last slot",
    unit: "%",
    decimals: 1,
    description:
      "Seam state: forward-filled SoC at the day's LAST timeline slot — the previous-slot SoC of the next day's first capacity pair, letting the boundary pair span midnight so a resumed reduce reproduces the full-history scan exactly.",
  },
  socCarryPct: {
    label: "SoC carry",
    unit: "%",
    decimals: 1,
    description:
      "Seam state: last non-null SoC observation at or before day end (may be inherited unchanged across SoC-dark days). The recal detector's reference SoC.",
  },
  eta: {
    label: "η round-trip",
    unit: "",
    decimals: 3,
    description:
      "APPLIED round-trip efficiency for the day: daily Σdischarge/Σcharge clamped to 0.70–1.0, smoothed by a causal ~10-day EWMA seeded at 0.90. Fitted from PRIOR days only so a bounded re-fold reproduces history. A slow decline reads as ageing; a step as a hardware change.",
  },
  capacityKwh: {
    label: "Capacity C",
    unit: "kWh",
    decimals: 2,
    description:
      "APPLIED usable capacity (kWh across the full 0→100% SoC span): the slope 100·Σcap_discharge/Σdown_swing through a causal EWMA, clamped 2–100, window seed 15. Lets the fold pin stored energy to (SoC − floor)/100·C. Null while SoC-blind or warming up.",
  },
  chargeEff: {
    label: "η_c charge",
    unit: "",
    decimals: 3,
    description:
      "APPLIED charge-side efficiency: slope of the causal least-squares fit ΔSoC·C/100 + discharge ≈ η_c·charge − idle, clamped 0.80–1.0 (~0.94 typical). Needs SoC, capacity and a 14-qualifying-day warm-up; while null the fold falls back to the single-η model.",
  },
  idleLossKwhDay: {
    label: "Idle loss",
    unit: "kWh/d",
    decimals: 3,
    description:
      "APPLIED idle/standby drain: the intercept of the same loss regression, clamped 0–2 kWh/day (~0.5 kWh/day ≈ 20 W of BMS, balancing and self-discharge). A real physical loss, removed from the store pro-rata at its own blend each interval.",
  },
  reserveFloorPct: {
    label: "Reserve floor",
    unit: "%",
    decimals: 1,
    description:
      "APPLIED reserve floor: the minimum operating SoC below which stored energy is treated as unusable. Learned as clamp(5th-percentile of trailing-90-day SoC minima − 2, 5, max ≈ 10). Data-driven where the battery discharges deep; pins to the upper clamp where the floor is unidentifiable (e.g. a genset comfort setpoint).",
  },
  foldStoredKwh: {
    label: "Stored E",
    unit: "kWh",
    decimals: 2,
    description:
      "Deliverable stored energy E in the blend fold at the START of the day (from the fold checkpoint). The denominator of every vended blend ratio; resets when the store empties or hits the floor/backstop.",
  },
  foldEstimatedKwh: {
    label: "Estimated E",
    unit: "kWh",
    decimals: 2,
    description:
      "Portion of the stored energy whose provenance was estimated/provisional at day start (e.g. charged while Amber prices were still provisional). estimated/E flags how much of the blend is still subject to revision.",
  },
  foldRenewableKwh: {
    label: "Renewable Qr",
    unit: "kWh",
    decimals: 2,
    description:
      "Renewable-energy content Qr of the store at day start. The vended renewable fraction is Qr/E.",
  },
  foldCarbonG: {
    label: "Carbon Qc",
    unit: "g",
    decimals: 0,
    description:
      "Carbon content Qc of the store at day start (gCO₂). The vended battery emissions intensity is Qc/E.",
  },
  foldCostC: {
    label: "Cost Qm",
    unit: "c",
    decimals: 1,
    description:
      "ACTUAL (out-of-pocket) cost basis Qm of the store at day start (cents, signed — solar charge is booked at 0). The vended battery price is Qm/E.",
  },
  foldCostOppC: {
    label: "Opp cost Qm",
    unit: "c",
    decimals: 1,
    description:
      "OPPORTUNITY cost basis of the store at day start (cents, signed — solar priced at the forgone feed-in). The vended opportunity price is Qm(opp)/E.",
  },
} as const satisfies Record<ProvenanceFieldKey, ProvenanceFieldMeta>;

// ── Chart/series definitions ────────────────────────────────────────────────────────────────────

/**
 * Panel series palette — validated (dataviz six-checks) against the gray-800 card surface:
 * lightness band, chroma floor, CVD adjacency and 3:1 contrast all pass. GRAY is deliberately
 * outside the categorical set (muted seam/quality series); amber is reserved for recal status
 * bands and never used as a series colour.
 */
export const SERIES_PALETTE = {
  blue: "rgb(59, 130, 246)", // blue-500
  green: "rgb(22, 163, 74)", // green-600
  violet: "rgb(139, 92, 246)", // violet-500
  cyan: "rgb(8, 145, 178)", // cyan-600
  rose: "rgb(244, 63, 94)", // rose-500
  greenLight: "rgb(74, 222, 128)", // green-400 — same-family step for gated-discharge
  gray: "rgb(156, 163, 175)", // gray-400 — muted (hidden/seam/quality series)
} as const;

/** Amber recal band (status-reserved; matches the app's warning hue). */
export const RECAL_BAND_COLOR = "rgba(245, 158, 11, 0.15)";

export interface ProvenanceSeriesDef {
  /** Unique across the whole panel. Field-backed series use the field key. */
  id: string;
  label: string;
  unit: string;
  axis: "y" | "y1";
  color: string;
  /** Chart.js borderDash. Probe overlays + opportunity variants are dashed. */
  dash?: number[];
  /** Render as a stepped line (applied params that change once per day). */
  stepped?: boolean;
  hiddenByDefault?: boolean;
  decimals: number;
  description: string;
  value: (
    fields: ProvenanceDailyResponse["fields"],
    i: number,
  ) => number | null;
}

export interface ProvenanceAxisDef {
  /** Short unit tag rendered on the axis (top tick suffix). */
  unit: string;
  min?: number;
  max?: number;
  suggestedMin?: number;
  suggestedMax?: number;
}

export interface ProvenanceChartDef {
  id: string;
  title: string;
  y: ProvenanceAxisDef;
  y1?: ProvenanceAxisDef;
  series: ProvenanceSeriesDef[];
  /** 0|1 field rendered as background bands rather than a line. */
  bandField?: ProvenanceFieldKey;
}

/** Build a SeriesDef straight from a field's meta (the 1:1 case). */
function fieldSeries(
  key: ProvenanceFieldKey,
  overrides: Pick<ProvenanceSeriesDef, "axis" | "color"> &
    Partial<Omit<ProvenanceSeriesDef, "id" | "value">>,
): ProvenanceSeriesDef {
  const meta = FIELD_META[key];
  return {
    id: key,
    label: meta.label,
    unit: meta.unit,
    decimals: meta.decimals,
    description: meta.description,
    value: (fields, i) => fields[key][i] ?? null,
    ...overrides,
  };
}

/** Derived ratio of two fold scalars; null when the store is empty or either input is null. */
function foldRatio(
  num: FoldDerivedKey,
  scale = 1,
): ProvenanceSeriesDef["value"] {
  return (fields, i) => {
    const n = fields[num][i];
    const e = fields.foldStoredKwh[i];
    if (n == null || e == null || e < 1e-6) return null;
    return (n / e) * scale;
  };
}

const PROBE_DASH = [4, 3];

export const PROVENANCE_CHARTS: ProvenanceChartDef[] = [
  {
    id: "throughput",
    title: "Energy throughput",
    y: { unit: "kWh/d", suggestedMin: 0 },
    series: [
      fieldSeries("chargeKwh", { axis: "y", color: SERIES_PALETTE.blue }),
      fieldSeries("dischargeKwh", { axis: "y", color: SERIES_PALETTE.green }),
      fieldSeries("capDischargeKwh", {
        axis: "y",
        color: SERIES_PALETTE.greenLight,
      }),
      fieldSeries("probeChargeKwh", {
        axis: "y",
        color: SERIES_PALETTE.blue,
        dash: PROBE_DASH,
      }),
      fieldSeries("probeDischargeKwh", {
        axis: "y",
        color: SERIES_PALETTE.green,
        dash: PROBE_DASH,
      }),
      fieldSeries("netAfterSocKwh", {
        axis: "y",
        color: SERIES_PALETTE.gray,
        hiddenByDefault: true,
      }),
    ],
  },
  {
    id: "soc",
    title: "State of charge",
    y: { unit: "%", min: 0, max: 100 },
    series: [
      fieldSeries("socMin", { axis: "y", color: SERIES_PALETTE.blue }),
      fieldSeries("socFirst", { axis: "y", color: SERIES_PALETTE.cyan }),
      fieldSeries("socLast", { axis: "y", color: SERIES_PALETTE.violet }),
      fieldSeries("reserveFloorPct", {
        axis: "y",
        color: SERIES_PALETTE.rose,
        stepped: true,
      }),
      fieldSeries("socCarryPct", {
        axis: "y",
        color: SERIES_PALETTE.gray,
        hiddenByDefault: true,
      }),
      fieldSeries("socLastSlotPct", {
        axis: "y",
        color: SERIES_PALETTE.gray,
        dash: PROBE_DASH,
        hiddenByDefault: true,
      }),
    ],
  },
  {
    id: "efficiencies",
    title: "Learned efficiencies",
    y: { unit: "", suggestedMin: 0.6, suggestedMax: 1.0 },
    series: [
      fieldSeries("eta", {
        axis: "y",
        color: SERIES_PALETTE.blue,
        stepped: true,
      }),
      fieldSeries("chargeEff", {
        axis: "y",
        color: SERIES_PALETTE.violet,
        stepped: true,
      }),
    ],
  },
  {
    id: "capacity",
    title: "Capacity & idle loss",
    y: { unit: "kWh", suggestedMin: 0 },
    y1: { unit: "kWh/d", min: 0, suggestedMax: 2 },
    series: [
      fieldSeries("capacityKwh", {
        axis: "y",
        color: SERIES_PALETTE.green,
        stepped: true,
      }),
      fieldSeries("idleLossKwhDay", {
        axis: "y1",
        color: SERIES_PALETTE.rose,
        stepped: true,
      }),
    ],
  },
  {
    id: "coverage",
    title: "Coverage & cycling",
    y: { unit: "", min: 0, suggestedMax: 288 },
    y1: { unit: "pp/d", suggestedMin: 0 },
    bandField: "recal",
    series: [
      fieldSeries("intervalCount", { axis: "y", color: SERIES_PALETTE.blue }),
      fieldSeries("socSamples", { axis: "y", color: SERIES_PALETTE.cyan }),
      fieldSeries("downSwingPct", { axis: "y1", color: SERIES_PALETTE.violet }),
    ],
  },
  {
    id: "contents",
    title: "Contents at day start",
    y: { unit: "kWh", suggestedMin: 0 },
    y1: { unit: "%", min: 0, max: 100 },
    series: [
      fieldSeries("foldStoredKwh", { axis: "y", color: SERIES_PALETTE.green }),
      fieldSeries("foldEstimatedKwh", {
        axis: "y",
        color: SERIES_PALETTE.gray,
      }),
      {
        id: "foldRenewablePct",
        label: "Renewable",
        unit: "%",
        axis: "y1",
        color: SERIES_PALETTE.cyan,
        decimals: 1,
        description:
          "Renewable share of the store at day start: Qr/E. What fraction of a kWh vended from the battery at midnight would count as renewable. Null when the store is empty.",
        value: foldRatio("foldRenewableKwh", 100),
      },
    ],
  },
  {
    id: "intensities",
    title: "Store intensities at day start",
    y: { unit: "g/kWh", suggestedMin: 0 },
    y1: { unit: "c/kWh" },
    series: [
      {
        id: "foldCarbonIntensity",
        label: "Emissions",
        unit: "gCO₂/kWh",
        axis: "y",
        color: SERIES_PALETTE.violet,
        decimals: 0,
        description:
          "Blended emissions intensity of the store at day start: Qc/E (gCO₂/kWh) — the intensity a load drawing from the battery at midnight would be attributed. Null when the store is empty.",
        value: foldRatio("foldCarbonG"),
      },
      {
        id: "foldCostIntensity",
        label: "Cost",
        unit: "c/kWh",
        axis: "y1",
        color: SERIES_PALETTE.blue,
        decimals: 1,
        description:
          "Blended ACTUAL (out-of-pocket) price of the store at day start: Qm/E (c/kWh). Solar charge is booked at 0, so heavy solar charging pulls this toward zero. Null when the store is empty.",
        value: foldRatio("foldCostC"),
      },
      {
        id: "foldCostOppIntensity",
        label: "Opp. cost",
        unit: "c/kWh",
        axis: "y1",
        color: SERIES_PALETTE.blue,
        dash: PROBE_DASH,
        decimals: 1,
        description:
          "Blended OPPORTUNITY price of the store at day start: Qm(opp)/E (c/kWh), with solar priced at the forgone feed-in rather than 0 — the value given up by storing instead of exporting. Null when the store is empty.",
        value: foldRatio("foldCostOppC"),
      },
    ],
  },
];

// ── Table-only bookkeeping rows (no line; rendered under the chart groups) ─────────────────────

export interface ProvenanceBookkeepingRow {
  id: string;
  label: string;
  description: string;
  /** Formatted display value at day index i, or null → "—". */
  value: (resp: ProvenanceDailyResponse, i: number) => string | null;
}

export const BOOKKEEPING_ROWS: ProvenanceBookkeepingRow[] = [
  {
    id: "recal",
    label: FIELD_META.recal.label,
    description: FIELD_META.recal.description,
    value: (resp, i) => {
      const v = resp.fields.recal[i];
      return v == null ? null : v ? "yes" : "no";
    },
  },
  {
    id: "firstIntervalEnd",
    label: "First interval",
    description:
      "Timestamp of the day's first agg_5m interval-end — the anchor where the day's forward-filled parameter step begins. Empty for a checkpoint-only row (a fold checkpoint written before the learn filled the day), which the fits treat as absent.",
    value: (resp, i) => {
      const v = resp.rowMeta.firstIntervalEnd[i];
      if (v == null) return null;
      const d = new Date(v);
      return isNaN(d.getTime()) ? v : d.toISOString().slice(11, 16) + " UTC";
    },
  },
  {
    id: "version",
    label: "Reduce version",
    description:
      "Reduce-algorithm version (BATTERY_DAILY_VERSION) this row was built with. A mismatch with the current code marks the day stale and forces a full input rebuild on the next learn.",
    value: (resp, i) => {
      const v = resp.rowMeta.version[i];
      return v == null ? null : `v${v}`;
    },
  },
  {
    id: "updatedAt",
    label: "Row updated",
    description: "When this day's row was last written by the learn (UTC).",
    value: (resp, i) => {
      const v = resp.rowMeta.updatedAt[i];
      if (v == null) return null;
      const d = new Date(v);
      return isNaN(d.getTime()) ? v : d.toISOString().slice(0, 16) + "Z";
    },
  },
];

/** All field keys, for the API route to iterate when building the dense columnar payload. */
export const PROVENANCE_FIELD_KEYS = Object.keys(
  FIELD_META,
) as ProvenanceFieldKey[];

/** The row-column subset of the keys (what the route reads straight off the row). */
export const PLOTTABLE_ROW_KEYS = PROVENANCE_FIELD_KEYS.filter(
  (k): k is PlottableRowKey => !k.startsWith("fold"),
);

/** The fold-derived subset (extracted from the validated checkpoint envelope). */
export const FOLD_DERIVED_KEYS = PROVENANCE_FIELD_KEYS.filter(
  (k): k is FoldDerivedKey => k.startsWith("fold"),
);
