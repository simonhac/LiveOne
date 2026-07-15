/**
 * Fold-state checkpoint envelope — pure (NO database, NO clock, NO IO).
 *
 * The blend fold is stateful; historically every recompute re-derived its state by folding forward
 * from a reset inside a 7-day warm-up lead-in. A checkpoint persists the fold's EXACT state at the
 * start of a local day (`battery_provenance_daily.fold_state`), so the minutely reconcile can seed the
 * fold from it and read only TODAY's inputs — O(today) instead of O(7.5 days) — while re-folding from
 * midnight each tick keeps late intra-day data self-healing with zero invalidation bookkeeping.
 *
 * `foldStep` is a pure function of (state, interval, config) and `foldBatteryProvenance` already
 * accepts an initial state (slice-and-chain identity is property-tested in fold.test.ts), so a seeded
 * fold reproduces the long fold's tail EXACTLY — provided the inputs are canonical (persisted params,
 * not in-window learners) and the two window-global config scalars are replayed from the envelope:
 *   • `reserveFloorPct` — the KV-cached sliding reserve floor in effect when the checkpoint was written;
 *   • `etaFallback`     — the throughput-weighted `etaUsed` summary (consumed only where etaSeries is null).
 * `anchorMs` is the END of the last folded interval ≤ the midnight — the seeded load/write must start
 * THERE (not at the midnight) so a gap straddling midnight reproduces the straddling interval exactly.
 */
import { FoldState, ResetTrigger } from "./fold";

/**
 * Checkpoint model version. Readers require exact equality — a mismatch silently falls back to the
 * warm-up path until the next nightly heal rewrites checkpoints (never a regression, no operator
 * action). BUMP THIS whenever anything that shapes fold behaviour changes semantics: fold.ts
 * (FoldState / foldStep / constants), compute.ts input construction (flows, η/C/losses resolution,
 * tariff, fold-config defaults), load.ts series semantics, or the learners (a PR-#169-style change).
 */
export const BATPROV_MODEL_VERSION = 1;

export interface FoldCheckpointEnvelope {
  /** == BATPROV_MODEL_VERSION at write time. */
  v: number;
  /** The local midnight this state represents (start of the row's day; fixed standard offset). */
  midnightMs: number;
  /** END of the last folded interval ≤ midnightMs — where a seeded load/fold/write starts. */
  anchorMs: number;
  /** FoldConfig.reserveFloorPct in effect (result.reserveUsed — the KV floor at write time). */
  reserveFloorPct: number;
  /** result.etaUsed — the foldConfig.efficiency fallback (used only where etaSeries[i] is null). */
  etaFallback: number;
  /** The fold state at anchorMs, verbatim. */
  state: FoldState;
}

/**
 * Exhaustive per-field spec — `satisfies Record<keyof FoldState, …>` makes ANY FoldState shape change
 * a compile error here, forcing the author to update the validator AND consider a
 * BATPROV_MODEL_VERSION bump (a semantic change with an unchanged shape still needs one!).
 */
const FOLD_STATE_SPEC = {
  storedKwh: "num",
  carbonG: "num",
  renewableKwh: "num",
  costC: "num",
  costOppC: "num",
  estimatedKwh: "num",
  pendingReset: "bool",
  pendingTrigger: "trigger",
  segmentIntervals: "num",
  segmentPeakKwh: "num",
  intervalsSinceSync: "num",
  socAnchored: "bool",
  totalChargeKwh: "num",
  totalDischargeKwh: "num",
  maxObservedCapacityKwh: "num",
  roundtripLossKwh: "num",
  roundtripLossG: "num",
  roundtripLossC: "num",
  roundtripLossOppC: "num",
  roundtripLossRenewKwh: "num",
  unattribLossKwh: "num",
  unattribLossG: "num",
  unattribLossC: "num",
  unattribLossOppC: "num",
  unattribLossRenewKwh: "num",
  idleLossKwh: "num",
  idleLossG: "num",
  idleLossC: "num",
  idleLossOppC: "num",
  idleLossRenewKwh: "num",
  syncKwh: "num",
  syncG: "num",
  syncRenewKwh: "num",
  syncC: "num",
  syncOppC: "num",
  syncEvents: "num",
  recalEvents: "num",
  resetsEmpty: "num",
  resetsSocFloor: "num",
  resetsBackstop: "num",
  prevSocPct: "numOrNull",
  netSinceSocKwh: "num",
} satisfies Record<keyof FoldState, "num" | "numOrNull" | "bool" | "trigger">;

const TRIGGERS: (ResetTrigger | null)[] = [
  null,
  "empty",
  "soc-floor",
  "backstop",
];

const isFiniteNum = (x: unknown): x is number =>
  typeof x === "number" && Number.isFinite(x);

/**
 * Validate an untrusted (jsonb round-tripped) envelope. Returns the typed envelope or null. Strict:
 * every numeric field must be FINITE (JSON.stringify turns NaN/±Infinity into null — a checkpoint
 * carrying one must never seed a fold), enums must be members, `anchorMs ≤ midnightMs`.
 */
export function validateFoldCheckpointEnvelope(
  x: unknown,
): FoldCheckpointEnvelope | null {
  if (typeof x !== "object" || x === null) return null;
  const e = x as Record<string, unknown>;
  if (
    !isFiniteNum(e.v) ||
    !isFiniteNum(e.midnightMs) ||
    !isFiniteNum(e.anchorMs) ||
    !isFiniteNum(e.reserveFloorPct) ||
    !isFiniteNum(e.etaFallback) ||
    e.anchorMs > e.midnightMs
  )
    return null;
  const s = e.state;
  if (typeof s !== "object" || s === null) return null;
  const st = s as Record<string, unknown>;
  for (const [key, kind] of Object.entries(FOLD_STATE_SPEC)) {
    const v = st[key];
    switch (kind) {
      case "num":
        if (!isFiniteNum(v)) return null;
        break;
      case "numOrNull":
        if (v !== null && !isFiniteNum(v)) return null;
        break;
      case "bool":
        if (typeof v !== "boolean") return null;
        break;
      case "trigger":
        if (!TRIGGERS.includes(v as ResetTrigger | null)) return null;
        break;
    }
  }
  return x as FoldCheckpointEnvelope;
}

/** Write-side guard: refuse to persist an envelope any validator-rejecting reader would discard. */
export function isPersistableFoldCheckpoint(
  env: FoldCheckpointEnvelope,
): boolean {
  return (
    validateFoldCheckpointEnvelope(JSON.parse(JSON.stringify(env))) !== null
  );
}

const DAY_MS = 86_400_000;

/**
 * All local midnights M with `startMs < M ≤ endMs`, each with the YYYY-MM-DD of the day STARTING at M.
 * Same fixed-offset day math as the learners/aggregation (end-exclusive bucketer: midnight of local
 * day d is `d·DAY_MS − offset`).
 */
export function localMidnightsInWindow(
  startMs: number,
  endMs: number,
  tzOffsetMin: number,
): { midnightMs: number; day: string }[] {
  const offMs = tzOffsetMin * 60_000;
  const out: { midnightMs: number; day: string }[] = [];
  // First local day whose midnight is strictly after startMs.
  let d = Math.floor((startMs + offMs) / DAY_MS) + 1;
  for (; d * DAY_MS - offMs <= endMs; d++) {
    out.push({
      midnightMs: d * DAY_MS - offMs,
      day: new Date(d * DAY_MS).toISOString().slice(0, 10),
    });
  }
  return out;
}
