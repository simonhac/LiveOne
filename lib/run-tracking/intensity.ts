/**
 * Where a run period's cost / emissions / renewable factors come from.
 *
 * A run's provenance is an ENERGY-WEIGHTED INTEGRAL over the run — `Σ sliceKwh × factor(t)` — not
 * `energy × constant`. `assignProvenanceToPeriods` (lib/run-tracking/energy.ts) does the
 * integration; this module supplies the factor series it integrates against, and decides when there
 * ISN'T one (in which case the columns are ABSENT, never $0.00).
 *
 * WHAT PRICES A DEVICE'S ENERGY is a per-role question, and the answer is deliberately enumerated
 * here rather than inferred:
 *
 *  - `generator` → the site's configured `generatorSource` triple. These are the very constants the
 *    battery-provenance fold substitutes for the OE/Amber grid signal (lib/battery-provenance/
 *    load.ts), so a run priced here and the same energy priced by the Sankey go through ONE
 *    resolution (`resolveGeneratorIntensity`, shared so the two can't drift).
 *  - a CONSUMING device (`ev`, and `pump` when it lands) → the fold's BLENDED load-path intensity at
 *    the moment of consumption: solar vs battery vs grid, moving every 5 minutes. Applying a
 *    generator's OUTPUT constants to a load would price consumption at the genset tariff — wrong,
 *    not approximate — so this leg REASSEMBLES the blend rather than borrowing one
 *    (`resolveLoadIntensity` below).
 *  - everything else → null.
 *
 * NOT `ROLES[role].category === "source"`, which looks right and isn't: `solar` is also a source
 * role (lib/roles/registry.ts), and `derivations.role` legally accepts it, so a solar run detector
 * would have every kWh priced at the site's DIESEL rate and booked as 1000 gCO₂/kWh. `category`
 * answers "which side of the flow", not "what prices this energy" — a different question that
 * happens to agree on one role.
 */
import { and, asc, eq } from "drizzle-orm";
import { alias } from "drizzle-orm/pg-core";
import type { planetscaleDb } from "@/lib/db/planetscale";
import {
  areaBindings,
  areaMembers,
  areas,
  devices,
  legacyHandles,
  points,
} from "@/lib/db/planetscale/schema";
import { resolveGeneratorIntensity } from "@/lib/battery-provenance/generator-source";
import {
  boundPoints,
  loadProvenanceInputs,
  resolveOeRegionPoints,
} from "@/lib/battery-provenance/load";
import {
  buildSourceIntensities,
  SOLAR_ACTUAL_COST,
} from "@/lib/battery-provenance/compute";
import {
  PERSISTED_BLEND_METRICS,
  readPersistedBatteryBlend,
} from "@/lib/battery-provenance/persisted-blend";
import { nemRegionForLocation } from "@/lib/vendors/openelectricity/region";
import type { AreaLocation } from "@/lib/areas/types";
import type { PointId } from "@/lib/ids";
import {
  sourceWeightsForInterval,
  type FlowSeries,
  type SourceIntensity,
} from "@/lib/aggregation/flow-matrix-core";
import type { ResolvedRunDetector } from "@/lib/derivations/resolve";
import type { RoleId } from "@/lib/roles/registry";

type PgDb = NonNullable<typeof planetscaleDb>;

/** The one role whose energy the `generatorSource` constants describe. */
const GENERATOR_ROLE: RoleId = "generator";

/**
 * The roles priced at the fold's BLENDED LOAD-PATH intensity — what the site was drawing on at the
 * moment of consumption.
 *
 * Enumerated for the same reason the generator is, and the failure it prevents is the mirror image:
 * `category === "load"` would sweep in `load.battery` (charging the battery is not consumption to
 * price — the fold already accounts for it, and pricing it here would double-count) and `grid`'s
 * load half (exporting is revenue, not cost). Add a role here only when "what did that device's
 * energy cost the site" is genuinely the question its runs answer.
 *
 * 🛑 ADDING A ROLE WHOSE CHANNEL HAS A LINKED SOURCE NEEDS ONE MORE CHANGE. `blendLoadIntensities`
 * divides by the whole generation pool because a priced load has no `source.<same-channel>` to
 * exclude — true for `ev`, and the two roles above are the ones for which it is false. The
 * accounting subtracts that source (`genWForLoad`); the blend would have to as well, which means
 * telling it which load it is pricing. It is not a hypothetical hazard: it is silent, and it is the
 * same class of drift the rest of this module is built to prevent.
 */
const LOAD_PRICED_ROLES: readonly RoleId[] = ["ev"];

/** The battery-provenance fold's native step. Used only to pad a requested window out to it. */
const FOLD_INTERVAL_MS = 5 * 60 * 1000;

/** The three factors at an instant. Each is independently null when unknown. */
export interface IntensitySample {
  /** Price of the run's energy, c/kWh. */
  priceC: number | null;
  /** Emissions intensity of the run's energy, gCO₂/kWh. */
  gPerKwh: number | null;
  /** Renewable fraction of the run's energy, 0..1. */
  renewable: number | null;
  /**
   * Share of this instant's load-path energy that `computeFlowAccounting` would count in
   * `estimated_kwh` (0..1) — the CONFIDENCE leg, and the reason it is one number rather than three:
   * the matrix's condition (`est || ei === null || rf === null || pr === null`,
   * lib/aggregation/flow-matrix-core.ts) is a single verdict per contribution, "not fully known",
   * not a per-metric shortfall. `selfRenewable` is deliberately outside it, there and here.
   *
   * NOT nullable, unlike the three factors above. A confidence denominator has no "unknown" state
   * that is not itself a reason for low confidence: where nothing at all is known this is 1, not
   * null. That is what lets `provenanceFromAllocation` sum it unconditionally.
   *
   * ⚠️ Same word, different subject to `FoldStep.estimatedFraction` (lib/battery-provenance/fold.ts),
   * which is the estimated share of the battery's STORED energy. This is the estimated share of the
   * LOAD PATH flowing at this instant.
   */
  estimatedFraction: number;
}

/**
 * A factor series over time. `at()` takes epoch-ms so a future per-interval implementation (the
 * load-side blend) drops in without touching the integrator.
 */
export interface IntensitySeries {
  at(tMs: number): IntensitySample;
}

/** A series that is the same at every instant — the off-grid generator case. */
export function constantIntensity(sample: IntensitySample): IntensitySeries {
  return { at: () => sample };
}

/** The window a load-side series must cover — the span of the runs being priced. */
export interface IntensityWindow {
  startMs: number;
  endMs: number;
}

/**
 * A STEP series over the fold's own timeline. `samples[i]` is the factor for fold interval `i`,
 * which spans `(timeline[i], timeline[i+1]]`.
 *
 * 🛑 **THE OFF-BY-ONE, and it has two halves — get either wrong and every run is a step out.**
 *
 * *Which sample belongs to which interval.* `computeFlowAccounting` reads every source intensity at
 * index `i` for the interval `[timeline[i], timeline[i+1]]`, while `writeBlendOutputs` stamps that
 * same step's persisted point at `interval_end = timeline[i+1]`. `blendLoadIntensities` therefore
 * indexes by `i` — the fold's convention, not the table's.
 *
 * *Which interval a timestamp lands in.* This is the half that is easy to get backwards, because it
 * does NOT follow from the above. `assignProvenanceToPeriods` prices each counter slice at
 * `at(<the slice's LATER reading>)` — energy that accrued over `(t_prev, t_next]` is sampled at
 * `t_next`. So the lookup must be RIGHT-CLOSED: the interval that ENDS at or after `tMs`, never the
 * one that begins exactly there. A left-closed lookup (`timeline[i] <= tMs`) reads correctly for
 * every slice strictly inside an interval and silently jumps a step for any slice ending exactly on
 * a 5-minute boundary — pricing energy at the factor of the interval AFTER the one it accrued in.
 *
 * Outside the loaded timeline every factor is null, so a run reaching past the window it was
 * resolved for loses provenance for those slices rather than being priced at the nearest edge.
 *
 * 🛑 DO NOT "IMPROVE" THIS BY SPLITTING A COUNTER STEP AT THE INTERVAL BOUNDARY IT SPANS. It looks
 * like a refinement — price each part at its own interval's factor — and it is measurably WRONG for
 * this system, because it breaks an alignment that already exists. `agg_5m.delta` for a
 * `transform='d'` counter is `last − previousLast`, so a raw step straddling a boundary is booked
 * WHOLLY to the interval holding its later reading; the right-closed lookup here prices that same
 * step at that same interval. The two conventions agree exactly, which is why a run's cost and the
 * flow matrix's cost for the same kWh come out identical to 4 dp. Splitting the step diverges from
 * the aggregator's own definition of "that interval's metered energy" — measured on a Kinkora week,
 * it moved the run total $0.042 (0.45%) away from the Sankey it had been matching exactly.
 */
export function stepIntensity(
  timeline: number[],
  samples: IntensitySample[],
): IntensitySeries {
  const UNKNOWN: IntensitySample = {
    priceC: null,
    gPerKwh: null,
    renewable: null,
    // Outside the loaded timeline nothing is known — which IS the estimated condition, not an
    // exemption from it. The matrix has no opinion here (it books no energy outside its own
    // timeline at all, so there is no parity constraint), but the run's counter books kWh
    // regardless, and 0 would claim full confidence about exactly that energy.
    estimatedFraction: 1,
  };
  return {
    at(tMs: number): IntensitySample {
      if (timeline.length < 2) return UNKNOWN;
      // Right-closed: t must lie in (timeline[0], last]. A slice ending exactly at the first
      // boundary accrued before this window and has no interval here.
      if (tMs <= timeline[0] || tMs > timeline[timeline.length - 1])
        return UNKNOWN;
      // Largest i with timeline[i] < tMs — the interval whose span CONTAINS the accrual ending at
      // tMs. There are n-1 steps for n boundaries, hence the clamp.
      let lo = 0;
      let hi = timeline.length - 2;
      while (lo < hi) {
        const mid = (lo + hi + 1) >> 1;
        if (timeline[mid] < tMs) lo = mid;
        else hi = mid - 1;
      }
      return samples[Math.min(lo, samples.length - 1)] ?? UNKNOWN;
    },
  };
}

/**
 * Blend the per-source intensities into ONE load-path factor per interval.
 *
 * The weights are the source shares `computeFlowAccounting` allocates by — obtained from the shared
 * `sourceWeightsForInterval`, not recomputed here, so a run's cost and the Sankey's cost for the
 * same kWh come from one arithmetic. A plain load like `load.ev` has no linked source
 * (`channelId("load.ev")` is `"ev"` and there is no `source.ev`), so the self-charge exclusion the
 * accounting applies to `load.battery`/`load.grid` does not apply and every source is in the pool.
 *
 * 🛑 A SOURCE WITH NO KNOWN FACTOR LEAVES THE NUMERATOR BUT STAYS IN THE DENOMINATOR, and getting
 * that backwards is the defect this comment exists to prevent recurring.
 *
 * It previously dropped such a source from both, reasoning that this reproduced the unbiased-average
 * rule the accounting's `*KnownKwh` denominators encode. The rule was right; the application was not.
 * `*KnownKwh` is the denominator for reporting an unbiased average INTENSITY — `emissionsG /
 * emissionsKnownKwh`. What this function feeds is `provenanceFromAllocation`, which multiplies by the
 * slice's WHOLE kWh to accumulate an ABSOLUTE `cost_c`. Multiplying a known-only average by the total
 * energy extrapolates the known sources' price onto energy they did not supply. The accounting never
 * does that: it allocates each source its own edge and simply contributes nothing from an edge it
 * cannot price (counting that energy in `estimatedKwh` instead).
 *
 * So the denominator here is the FULL generation pool, exactly as `computeFlowAccounting` divides by
 * `genWForLoad`, and the identity is exact rather than approximate:
 *
 *     Σ_known(w·p) / W_total  ×  loadKwh   ≡   Σ_known (loadKwh · w/W_total) · p   =   the matrix's costC
 *
 * (Equivalently: the unbiased average × the KNOWN share of the energy. Same number, and it is worth
 * seeing it both ways — the first is what the code computes, the second is why it is honest.)
 *
 * WHAT THIS COSTS, stated plainly: when a source's factor is unknown the run's cost is UNDERSTATED,
 * because that energy contributes nothing. It is understated by exactly as much as the Sankey's is,
 * which is the point — the two surfaces are now wrong in the same direction and by the same amount,
 * instead of wrong in opposite directions. The Sankey flags the shortfall in `estimated_kwh`, and so
 * now does a run: `estimatedFraction` is the fourth leg computed below, off the SAME weights and the
 * SAME denominator, and `derived_intervals.estimated_kwh` is its integral (migration 0057). A run
 * that reads cheap because part of it was unpriceable now says so.
 *
 * When NO source has a known factor the factor stays null and the integrator omits the slice
 * entirely — absent, never $0.00. Unchanged, and the reason the null/zero distinction survives this.
 *
 * The weights are `numerW`, not `denomW`, for the same one-arithmetic reason: the accounting's
 * numerator skips a source whose interval has a mid-interval gap (present in the pool, out of the
 * allocation) while still counting it in the denominator, and a copy that used `denomW` on both sides
 * would silently re-admit it.
 */
export function blendLoadIntensities(
  timeline: number[],
  sources: FlowSeries[],
  loads: FlowSeries[],
  sourceIntensities: (SourceIntensity | null)[],
): IntensitySample[] {
  const steps: IntensitySample[] = [];
  for (let i = 0; i < timeline.length - 1; i++) {
    const deltaHours = (timeline[i + 1] - timeline[i]) / 3_600_000;
    // `loads` is passed even though only the SOURCE weights are read: `anyExact` — the kWh-vs-kW
    // switch that decides how every weight is computed — is set by scanning sources AND loads. Pass
    // an empty array and an area whose loads are metered but whose sources are not would blend on
    // the legacy power weights while the Sankey allocated on exact-energy ones. Same inputs, same
    // switch, same weights.
    const { numerW, totalGenW } = sourceWeightsForInterval(
      sources,
      loads,
      i,
      deltaHours,
    );
    if (totalGenW <= 0) {
      // The matrix `continue`s here too, so it books neither energy nor estimated energy and there
      // is no parity constraint. The run's counter books energy regardless, and none of it can be
      // attributed to anything: all of it is estimated. See `UNKNOWN` above for the same reasoning.
      steps.push({
        priceC: null,
        gPerKwh: null,
        renewable: null,
        estimatedFraction: 1,
      });
      continue;
    }
    // The accounting's `genWForLoad` — `totalGenW` minus the load's own linked source. A priced load
    // has no linked source today (see `LOAD_PRICED_ROLES`), so the subtraction is a no-op and the
    // pool is whole; naming it keeps the correspondence visible if that ever stops being true.
    const genWForLoad = totalGenW;
    let priceNum = 0;
    let anyPrice = false;
    let gNum = 0;
    let anyG = false;
    let renNum = 0;
    let anyRen = false;
    // The CONFIDENCE numerator — the same weights and the same `genWForLoad` denominator as the
    // three above, which is the whole parity claim. A source with `numerW === null` is skipped here
    // for the same reason the matrix skips it (it gets no edge, so none of its energy can be
    // estimated) while its `denomW` stays in the pool — so an interval's fractions do NOT sum to 1
    // when a source is out of the allocation. The matrix leaks that energy identically.
    let estimatedW = 0;
    for (let s = 0; s < sources.length; s++) {
      // `null` = in the pool but out of the allocation, exactly as the accounting reads it. A
      // negative weight is NOT filtered, also exactly as the accounting reads it — a guard here that
      // the matrix does not have is a divergence, whatever it protects against.
      const w = numerW[s];
      if (w === null) continue;
      const si = sourceIntensities[s];
      if (!si) {
        // An unknown-intensity source (e.g. source.generator). The matrix's `est = si ? … : true`:
        // no intensity object at all is its STRONGEST estimated case, not an exemption. Recorded
        // before the `continue` that leaves the three numerators untouched.
        estimatedW += w;
        continue;
      }
      const p = si.price[i];
      if (p !== null && p !== undefined) {
        priceNum += w * p;
        anyPrice = true;
      }
      const g = si.emissions[i];
      if (g !== null && g !== undefined) {
        gNum += w * g;
        anyG = true;
      }
      const r = si.renewable[i];
      if (r !== null && r !== undefined) {
        renNum += w * r;
        anyRen = true;
      }
      // 🛑 LITERALLY the matrix's test — `=== null`, not the numerators' looser `!== null &&
      // !== undefined` above. The looser guard is defensive padding this function grew; copying it
      // here would be a guard the matrix does not have, which is a divergence whatever it protects
      // against. Moot in practice: `buildSourceIntensities` fills every array to `timeline.length`
      // while this loop only reaches `timeline.length - 2`, so `undefined` is unreachable.
      // `selfRenewable` is deliberately NOT in the condition — the matrix's `sr` leg does not feed
      // `estimatedKwh`, and adding it here would move every number relative to the Sankey.
      if (si.estimated[i] === true || p === null || g === null || r === null)
        estimatedW += w;
    }
    steps.push({
      priceC: anyPrice ? priceNum / genWForLoad : null,
      gPerKwh: anyG ? gNum / genWForLoad : null,
      renewable: anyRen ? renNum / genWForLoad : null,
      estimatedFraction: estimatedW / genWForLoad,
    });
  }
  return steps;
}

/**
 * The SITE the detector's device belongs to — the area whose bindings the battery-provenance fold
 * reads — as both its battery device's config and its addressing handle.
 *
 * WHY THIS IS TWO HOPS. `generatorSource` is config on the site's BATTERY device, and the fold is
 * keyed by the site area's handle — but a detector's OWN area is typically a device-level area-of-one
 * with no bindings at all (Daylesford's generator detector hangs off the Selectronic's area and
 * Kinkora's EV detector off the Mondo's; the battery binding is on the site area that contains
 * them). So: detector's area → its member devices → every area those devices belong to → the
 * `role=battery, metric=power` binding → that device's config, and that area's handle. One place to
 * configure: a site that prices its Sankey prices its runs.
 */
async function resolveSiteForDetector(
  db: PgDb,
  det: ResolvedRunDetector,
): Promise<{
  config: (typeof devices.$inferSelect)["config"] | null;
  handle: number | null;
  /** The SITE area's id — what `boundPoints` is keyed by (the fold reaches it via `handle`). */
  areaId: string;
  /** The site area's location, for the NEM region the grid signal comes from. */
  location: AreaLocation | null;
} | null> {
  const member = alias(areaMembers, "member");
  const sibling = alias(areaMembers, "sibling");
  const [row] = await db
    .select({
      config: devices.config,
      handle: legacyHandles.handle,
      areaId: sibling.areaId,
      location: areas.location,
    })
    .from(member)
    .innerJoin(sibling, eq(sibling.deviceId, member.deviceId))
    .innerJoin(
      areaBindings,
      and(
        eq(areaBindings.areaId, sibling.areaId),
        eq(areaBindings.role, "battery"),
        eq(areaBindings.metricType, "power"),
      ),
    )
    // The battery binding's device, reached through the binding's uuid (`points.device_id`) since
    // slice E PR 2a. Slice K2 deleted the trailing `devices.rid → systems.id` bridge: `devices.config`
    // IS the config, so the hop carried nothing. Both joins are INNER, exactly as the single one they
    // replace was: `point_uid` is NOT NULL with an FK into `points`, and `points.device_id` an FK into
    // `devices`, so neither can drop a row — and removing the bridge removed the one hop that could
    // (an unmatched handle), so this is now strictly total.
    .innerJoin(points, eq(points.id, areaBindings.pointUid))
    .innerJoin(devices, eq(devices.id, points.deviceId))
    // LEFT, so a site area without a `legacy_handles` row still yields its battery config (the
    // generator leg needs only that). Only the load leg, which is handle-keyed, then degrades.
    .leftJoin(legacyHandles, eq(legacyHandles.areaId, sibling.areaId))
    // INNER, and total: `area_members.area_id` is an FK into `areas`, so this cannot drop a row.
    .innerJoin(areas, eq(areas.id, sibling.areaId))
    .where(eq(member.areaId, det.areaId))
    // ORDINAL, not priority — this must agree with the fold, which picks the battery device as the
    // first `role=battery, metric=power` of `boundPoints`, ordered by `ordinal`
    // (lib/battery-provenance/load.ts). Ordering by `priority` looks equivalent and is not: the two
    // columns are independent, so a site with two battery bindings could price its runs off one
    // device and its Sankey off the other.
    //
    // `areaId` is the tiebreak, and it is load-bearing rather than cosmetic: this query fans out
    // across EVERY area the device belongs to, while `ordinal` is only meaningful WITHIN one area
    // (`area_bindings_slot_priority_unique` is scoped to `area_id`). Without it, two areas binding
    // at the same ordinal would resolve to whichever row Postgres happened to emit first — and the
    // reader and the writer run this query separately, so they could disagree between two requests.
    .orderBy(asc(areaBindings.ordinal), asc(sibling.areaId))
    .limit(1);

  return row
    ? {
        config: row.config ?? null,
        handle: row.handle ?? null,
        areaId: row.areaId,
        location: (row.location ?? null) as AreaLocation | null,
      }
    : null;
}

/**
 * The `agg_5m` points a load-priced run's provenance is READ FROM — the staleness probe's watch set.
 *
 * 🛑 THIS MUST NAME EXACTLY WHAT {@link resolveLoadIntensity} READS, and the two are changed
 * together. A factor that can move without appearing here is a run that silently disagrees with the
 * Sankey forever, which is the whole defect `rehealStaleRuns` exists to close; a point named here
 * that nothing reads only costs an occasional no-op re-price.
 *
 * Empty (→ the caller skips the detector) for any role the load blend doesn't price: `generator` is
 * priced from configured constants, which cannot drift, and every other role has no provenance at
 * all. Empty is "nothing to watch", never "nothing moved".
 *
 * The generator-source override is mirrored from `loadProvenanceInputs`: a site whose battery device
 * declares `generatorSource` prices its "grid" port from constants, so the OE region signal feeds
 * nothing — and the Amber rate feeds nothing either, but only when the configured triple carries a
 * price (the loader overrides emissions/renewables unconditionally and price only when non-null).
 */
export async function resolveIntensityInputPoints(
  db: PgDb,
  det: ResolvedRunDetector,
): Promise<PointId[]> {
  if (!(LOAD_PRICED_ROLES as readonly string[]).includes(det.role)) return [];
  const site = await resolveSiteForDetector(db, det);
  // No handle ⇒ `resolveLoadIntensity` returns null and the run is never priced — nothing to watch.
  if (site?.handle == null) return [];

  const gen = resolveGeneratorIntensity(
    site.config?.batteryProvenance?.generatorSource,
  );
  const bound = await boundPoints(db, site.areaId);
  const watched: PointId[] = [];
  for (const b of bound) {
    if (b.stem === "bidi.battery" && PERSISTED_BLEND_METRICS.includes(b.metric))
      watched.push(b.point);
    else if (
      b.role === "grid" &&
      b.metric === "rate" &&
      b.stem === "bidi.grid.import" &&
      !(gen && gen.priceC != null)
    )
      watched.push(b.point);
  }
  if (!gen) {
    const oe = await resolveOeRegionPoints(
      db,
      nemRegionForLocation(site.location),
    );
    for (const p of oe) watched.push(p.point);
  }
  return [...new Set(watched)];
}

/**
 * A CONSUMING device's factor series: the blended load-path intensity, step by step.
 *
 * There is no per-interval load blend persisted anywhere to read, so this assembles one — but note
 * carefully WHICH of the two halves it computes, because the difference is a defect this function
 * used to have:
 *
 *  - The BLEND (`sourceWeightsForInterval` + `blendLoadIntensities`) is STATELESS: interval `i`
 *    depends only on interval `i`. Computing it here is safe at any window size, and it is the only
 *    thing genuinely missing from the database.
 *  - The FOLD (`computeBatteryProvenance`) is STATEFUL: the battery's contents at any instant depend
 *    on everything since the last reset, so it is correct only when started from a checkpoint or a
 *    full warm-up. This function used to run one over the run's own span padded by five minutes —
 *    i.e. always cold — and a cold fold seeds the store's blend from the SITE FALLBACK, which is the
 *    grid's instantaneous intensity and price (lib/battery-provenance/fold.ts). The observed symptom
 *    was a Kinkora EV session supplied 100% by a solar-charged battery being billed at 33.7 c/kWh
 *    and 742 gCO₂/kWh — the grid import rate of the minute the fold happened to start.
 *
 * So the fold is gone from here entirely. `readPersistedBatteryBlend` reads the engine's own
 * per-interval output (`bidi.battery/*`, written from a checkpoint-seeded fold by the minutely
 * reconcile and re-written by the nightly heal) and `buildSourceIntensities` — the same pure
 * assembler the Sankey uses — turns it into the per-source array the blend consumes. A run and the
 * daily attribution now read one number rather than deriving two.
 *
 * Every failure is null, never a fallback: no site handle, no inputs (a data-less window), a
 * timeline too short to have a step, or a battery in the flow series with no persisted blend to
 * price it. The columns then stay absent, which is the same answer this function gave for every
 * load role before it existed.
 */
async function resolveLoadIntensity(
  db: PgDb,
  det: ResolvedRunDetector,
  window: IntensityWindow,
): Promise<IntensitySeries | null> {
  const site = await resolveSiteForDetector(db, det);
  if (site?.handle == null) return null;

  // Pad so the timeline BRACKETS the runs rather than starting inside them: it is built from the
  // agg_5m rows in the requested range, so an unpadded window starts at or after the run's own
  // start — and `stepIntensity` is right-closed, so the run's first counter slice would end at or
  // before `timeline[0]` and price at null. One interval either side is enough. This is the whole
  // reason for the padding; it was never (and could never have been) a fold warm-up.
  const inputs = await loadProvenanceInputs(site.handle, {
    startMs: window.startMs - FOLD_INTERVAL_MS,
    endMs: window.endMs + FOLD_INTERVAL_MS,
  });
  if (!inputs || inputs.timeline.length < 2) return null;

  const hasBattery = inputs.sources.some((s) => s.path === "source.battery");
  const blend = await readPersistedBatteryBlend(
    db,
    inputs.areaId,
    inputs.timeline,
  );
  // A battery in the flow series that the engine has never written a blend for is ABSENT provenance,
  // not cheap provenance: `blendLoadIntensities` would quietly drop the battery's share from both
  // sides of the average and report the run at the intensity of whatever else was running. Refusing
  // is the same "unknown ≠ zero" rule the energy path applies.
  //
  // 🛑 The gate is `present`, NOT `covered`. An EMPTY battery has fully-computed intervals with null
  // intensities (there is no blend to report) and a real `stored-energy` of 0 — gating on a known
  // intensity would read a flat battery as a missing engine and refuse to price a run that grid and
  // solar can price exactly. Measured on prod: that mistake would have dropped provenance from 5 EV
  // sessions (14.4 kWh, $2.88) whose days `flow_attr_1d` prices without difficulty.
  if (hasBattery && (blend === null || blend.present === 0)) return null;

  const sourceIntensities = buildSourceIntensities({
    sources: inputs.sources,
    timeline: inputs.timeline,
    gridEmissions: inputs.gridEmissions,
    gridRenewable: inputs.gridRenewable,
    gridPrice: inputs.gridPrice,
    gridEmissionsEstimated: inputs.gridEmissionsEstimated,
    gridPriceEstimated: inputs.gridPriceEstimated,
    steps: blend?.steps ?? [],
    solarCost: SOLAR_ACTUAL_COST,
  });
  const steps = blendLoadIntensities(
    inputs.timeline,
    inputs.sources,
    inputs.loads,
    sourceIntensities,
  );
  return stepIntensity(inputs.timeline, steps);
}

/**
 * Resolve the factor series for a detector, or null when this device's intensity is unknowable.
 *
 * Resolved ONCE per detector per recompute — never per run. `window` is required by the load leg
 * (it folds over that span) and ignored by the generator leg (constants); a caller with no runs to
 * price should not call this at all.
 */
export async function resolveIntensitySeries(
  db: PgDb,
  det: ResolvedRunDetector,
  window: IntensityWindow,
): Promise<IntensitySeries | null> {
  // Enumerated, not inferred — see the module doc on why `category === "source"` is the wrong gate.
  if (det.role === GENERATOR_ROLE) {
    const site = await resolveSiteForDetector(db, det);
    const gen = resolveGeneratorIntensity(
      site?.config?.batteryProvenance?.generatorSource,
    );
    if (!gen) return null;
    return constantIntensity({
      priceC: gen.priceC,
      gPerKwh: gen.gPerKwh,
      renewable: gen.renewable,
      // The matrix's `pr === null` clause, applied to configured constants. `resolveGeneratorIntensity`
      // gates `pricePerKwh` INDEPENDENTLY of the emissions master gate, so a site can configure
      // emissions and no price — and that run's energy is exactly as unpriceable as a grid interval
      // with a null tariff. `gPerKwh` and `renewable` are always finite when `gen` is non-null, so
      // price is the only clause that can fire; a fully-configured generator is never estimated.
      estimatedFraction: gen.priceC === null ? 1 : 0,
    });
  }
  if ((LOAD_PRICED_ROLES as readonly string[]).includes(det.role)) {
    return resolveLoadIntensity(db, det, window);
  }
  return null;
}
