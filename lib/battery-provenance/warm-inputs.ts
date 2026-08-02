/**
 * The one way to get inputs a fold may legitimately run over: "the fold's state at time T, played
 * forward".
 *
 * This is the seed-else-warm-up dance that used to live inline in `buildAttributedFlowMatrix`, where
 * it was the private knowledge of a single caller. That is why it was possible for the EV run pricing
 * to fold over a five-minute-padded window and price a battery-supplied charge session at the grid
 * tariff: the correct behaviour existed, but as a body of code rather than as an interface, so a new
 * caller had no way to ask for it and no way to find out it had not.
 *
 * Order of preference, and it is almost always the first:
 *  1. SEED from the freshest persisted checkpoint at/before the window start and fold forward from
 *     its anchor. `battery_provenance_daily.fold_state` carries one per local midnight, so this
 *     typically reads O(hours) rather than O(days), and replay is EXACT (slice-and-chain identity is
 *     property-tested in fold.test.ts).
 *  2. Else load `startMs − WARMUP_MS` from a zero state — the safety net for a genuinely absent
 *     checkpoint (new Area, a `BATPROV_MODEL_VERSION` bump, a heal that has not run for days).
 *
 * A fallback is never silent. It is not an error either — the result is still usable — but it reads
 * more data and starts colder, so it is worth knowing about when it becomes common.
 */
import type { planetscaleDb } from "@/lib/db/planetscale";
import {
  tryLoadSeededProvenanceInputs,
  WARMUP_MS,
} from "@/lib/db/planetscale/battery-provenance-pg";
import { loadProvenanceInputs, type LoadOptions } from "./load";
import { certifyWarmInputs, type WarmProvenanceInputs } from "./types";
import type { FoldState } from "./fold";

type PgDb = NonNullable<typeof planetscaleDb>;

export interface WarmInputsResult {
  inputs: WarmProvenanceInputs;
  /** Present only on the seeded path — pass straight into `computeBatteryProvenance`'s options. */
  initialState?: FoldState;
  efficiencyFallback?: number;
  /** Where the fold actually starts: the checkpoint's anchor, or `startMs − WARMUP_MS`. */
  anchorMs: number;
  seeded: boolean;
  /** Why the seed was refused — one of `tryLoadSeededProvenanceInputs`' guard reasons. */
  reason?: string;
}

/**
 * Warm inputs for `[startMs, endMs]`, or null when the Area/window yields nothing loadable at all.
 *
 * `opts` is forwarded to the loader unchanged (a pre-resolved logical system, a request-scoped
 * `agg_5m` cache) — the seeded path threads it too, so a caller that already fetched its rows does
 * not re-query on either branch.
 */
export async function loadWarmProvenanceInputs(
  db: PgDb,
  handle: number,
  window: { startMs: number; endMs: number },
  opts: LoadOptions = {},
): Promise<WarmInputsResult | null> {
  const { startMs, endMs } = window;

  // Best-effort: any failure here — including a thrown error, not just a guard's {seeded:false} —
  // must degrade to the unseeded load below. Seeding must never be LESS safe than the path that
  // predates it.
  let seed: Awaited<ReturnType<typeof tryLoadSeededProvenanceInputs>>;
  try {
    seed = await tryLoadSeededProvenanceInputs(
      db,
      handle,
      startMs,
      endMs,
      opts.logicalSystem,
      opts.avgCache,
    );
  } catch (err) {
    console.error("[BatProv] checkpoint seed lookup failed:", err);
    seed = { seeded: false, reason: "seed-lookup-threw" };
  }

  if (seed.seeded) {
    return {
      inputs: certifyWarmInputs(seed.inputs, "seeded from a fold checkpoint"),
      initialState: seed.initialState,
      efficiencyFallback: seed.efficiencyFallback,
      anchorMs: seed.anchorMs,
      seeded: true,
    };
  }

  const anchorMs = startMs - WARMUP_MS;
  const inputs = await loadProvenanceInputs(
    handle,
    { startMs: anchorMs, endMs },
    opts,
  );
  if (!inputs) return null;
  // Loud, because the cost is invisible in the output: this reads a week of agg_5m it did not need
  // and starts the fold from a zero state. Rare is fine; common means the checkpoints have stopped
  // being written, or a guard is mis-specified.
  console.warn(
    `[BatProv] fold ran UNSEEDED (${seed.reason}) for handle=${handle} — ` +
      `${WARMUP_MS / 86_400_000}d warm-up from a zero state`,
  );
  return {
    inputs: certifyWarmInputs(inputs, "unseeded WARMUP_MS lead-in from zero"),
    anchorMs,
    seeded: false,
    reason: seed.reason,
  };
}
