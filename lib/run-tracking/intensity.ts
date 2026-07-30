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
 *    the moment of consumption: solar vs battery vs grid, moving every 5 minutes. That series does
 *    not exist per-interval anywhere today (the load blend only materialises as an aggregate inside
 *    `computeFlowAccounting`), so this returns null and the columns stay absent. Applying a
 *    generator's OUTPUT constants to a load would price consumption at the genset tariff — wrong,
 *    not approximate.
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
  devices,
  points,
} from "@/lib/db/planetscale/schema";
import { resolveGeneratorIntensity } from "@/lib/battery-provenance/generator-source";
import type { ResolvedRunDetector } from "@/lib/derivations/resolve";
import type { RoleId } from "@/lib/roles/registry";

type PgDb = NonNullable<typeof planetscaleDb>;

/** The one role whose energy the `generatorSource` constants describe. */
const GENERATOR_ROLE: RoleId = "generator";

/** The three factors at an instant. Each is independently null when unknown. */
export interface IntensitySample {
  /** Price of the run's energy, c/kWh. */
  priceC: number | null;
  /** Emissions intensity of the run's energy, gCO₂/kWh. */
  gPerKwh: number | null;
  /** Renewable fraction of the run's energy, 0..1. */
  renewable: number | null;
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

/**
 * Resolve the factor series for a detector, or null when this device's intensity is unknowable.
 *
 * One small query, so it is resolved ONCE per detector per recompute — never per run.
 */
export async function resolveIntensitySeries(
  db: PgDb,
  det: ResolvedRunDetector,
): Promise<IntensitySeries | null> {
  // Enumerated, not inferred — see the module doc on why `category === "source"` is the wrong gate.
  if (det.role !== GENERATOR_ROLE) return null;

  // WHERE THE CONSTANTS LIVE, and why this is two hops. `generatorSource` is config on the site's
  // BATTERY device — the one the fold reads (lib/battery-provenance/load.ts resolves it through the
  // area's `role=battery, metric=power` binding). But a detector's OWN area is typically a
  // device-level area-of-one with no bindings at all (Daylesford's generator detector hangs off the
  // Selectronic's area; the battery binding is on the "Daylesford" site area that contains it). So:
  // detector's area → its member devices → every area those devices belong to → the battery
  // binding → that device's config. One place to configure: a site that prices its Sankey prices
  // its runs.
  const member = alias(areaMembers, "member");
  const sibling = alias(areaMembers, "sibling");
  const [row] = await db
    .select({ config: devices.config })
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
    // slice E PR 2a. Slice K2 deleted the trailing `devices.rid → devices.id` bridge: `devices.config`
    // IS the config, so the hop carried nothing. Both joins are INNER, exactly as the single one they
    // replace was: `point_uid` is NOT NULL with an FK into `points`, and `points.device_id` an FK into
    // `devices`, so neither can drop a row — and removing the bridge removed the one hop that could
    // (an unmatched handle), so this is now strictly total.
    .innerJoin(points, eq(points.id, areaBindings.pointUid))
    .innerJoin(devices, eq(devices.id, points.deviceId))
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

  const gen = resolveGeneratorIntensity(
    row?.config?.batteryProvenance?.generatorSource,
  );
  if (!gen) return null;

  return constantIntensity({
    priceC: gen.priceC,
    gPerKwh: gen.gPerKwh,
    renewable: gen.renewable,
  });
}
