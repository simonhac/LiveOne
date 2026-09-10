/**
 * `derivation_sources` — a derivation's typed input ports, as rows (migration 0063).
 *
 * This is the relational twin of `derivations.source_points jsonb`. Both are written while the
 * jsonb is still the declared shape on the wire (0064 drops the vestige); everything that READS a
 * derivation's wiring reads from here, because only here is the wiring proved:
 *
 *  - the PK `(derivation_id, slot)` makes "two signal points" unrepresentable;
 *  - the per-kind CHECK refuses `power` on a run-detector and a misspelled `signl` on either;
 *  - the composite FK `(point_id, device_id) → points(id, device_id)` makes `device_id` PROVABLY
 *    the point's own device — which is what lets a derivation's SITE be derived rather than
 *    configured.
 *
 * 🛑 **Keep the two in step.** A writer that updates one and not the other is the whole hazard of a
 * dual-write window: the jsonb is what the wire still shows, the rows are what the engines act on,
 * and a disagreement is a detector that reads one point and reports another. Every write goes
 * through {@link writeDerivationSources}.
 */
import { and, eq, inArray } from "drizzle-orm";
import type { requirePlanetscaleDb } from "@/lib/db/planetscale";
import { derivationSources, points } from "@/lib/db/planetscale/schema";
import { HWS_MODEL_KIND, RUN_DETECTOR_KIND } from "./kinds";

type PgDb = ReturnType<typeof requirePlanetscaleDb>;
type PgTx = Parameters<Parameters<PgDb["transaction"]>[0]>[0];
/**
 * A db handle OR an open transaction. Every caller here writes `derivation_sources` alongside a
 * `derivations` write, and 🛑 the two MUST land together — a parent whose sources failed to insert
 * is invisible to `findDerivationBySource`, so a retry re-mints the same deterministic id and dies
 * on the PK instead. So the callers open a transaction and pass it in.
 */
export type DerivationSourceExec = PgDb | PgTx;

/**
 * The slot vocabulary, per kind — the TypeScript twin of `derivation_sources_slot_check`.
 *
 * Deliberately per-kind rather than one flat union, exactly as the CHECK is: the failure this
 * prevents is not a typo (tsc catches those) but a legal slot name attached to the wrong kind,
 * which the database would reject at INSERT time — a 500 rather than a 422 — if code let it through.
 */
export const SLOTS_BY_KIND = {
  [RUN_DETECTOR_KIND]: ["signal", "energy", "boundary"],
  [HWS_MODEL_KIND]: ["power"],
} as const satisfies Record<string, readonly string[]>;

/**
 * Write a derivation's source rows, replacing whatever it had.
 *
 * `device_id` is NOT taken from the caller: it is looked up from `points`, because the composite FK
 * would reject a wrong one anyway and a 500 at the constraint is a worse error than a refusal here.
 * A slot naming a point that does not exist is dropped and reported — the caller (`ensureRunDetector`
 * and friends) has already refused that case, so reaching it means a race, not a typo.
 *
 * Delete-then-insert rather than an upsert: the set of slots is part of the wiring, so clearing
 * `boundary` has to be expressible, and a slot that is no longer named must not linger. Both
 * statements run inside the caller's transaction where there is one.
 */
export async function writeDerivationSources(
  db: DerivationSourceExec,
  input: {
    derivationId: string;
    kind: string;
    role: string | null;
    /** slot → `points.id` uuid. A null/absent value means "this slot is not wired". */
    slots: Record<string, string | null | undefined>;
  },
): Promise<void> {
  // 🛑 Refuse a slot this kind does not have, BEFORE the delete. `SLOTS_BY_KIND` is the CHECK's
  // twin, and without this the delete lands and the insert then dies on the constraint — leaving the
  // derivation with NO wiring at all. That is not hypothetical: the PATCH route's boundary leg
  // reaches here with a `boundary` slot, which an `hws-model` does not have.
  const legal = (SLOTS_BY_KIND as Record<string, readonly string[]>)[
    input.kind
  ];
  if (!legal)
    throw new Error(
      `writeDerivationSources: unknown derivation kind '${input.kind}'`,
    );
  const wanted = Object.entries(input.slots).filter(
    (e): e is [string, string] => typeof e[1] === "string" && e[1] !== "",
  );
  const illegal = wanted
    .map(([slot]) => slot)
    .filter((s) => !legal.includes(s));
  if (illegal.length > 0)
    throw new Error(
      `writeDerivationSources: kind '${input.kind}' has no slot(s) ${illegal.join(", ")} (has: ${legal.join(", ")})`,
    );
  const deviceByPoint = new Map<string, string>();
  if (wanted.length > 0) {
    const rows = await db
      .select({ id: points.id, deviceId: points.deviceId })
      .from(points)
      .where(inArray(points.id, [...new Set(wanted.map(([, uid]) => uid))]));
    for (const r of rows) deviceByPoint.set(r.id, r.deviceId);
  }

  const values = wanted.flatMap(([slot, pointId]) => {
    const deviceId = deviceByPoint.get(pointId);
    if (!deviceId) {
      console.warn(
        `[Derivations] ${input.derivationId}: slot '${slot}' names point ${pointId}, which has no points row — not wired`,
      );
      return [];
    }
    return [
      {
        derivationId: input.derivationId,
        slot,
        pointId,
        deviceId,
        kind: input.kind,
        role: input.role,
      },
    ];
  });

  await db
    .delete(derivationSources)
    .where(eq(derivationSources.derivationId, input.derivationId));
  if (values.length > 0) await db.insert(derivationSources).values(values);
}

/**
 * Does a derivation already exist for this (kind, role) wired to this signal point? The natural-key
 * existence check that replaces "mint the deterministic id and look it up".
 *
 * 🛑 Minting an id to ask whether a row exists is what made `derivations.id` load-bearing for a
 * question that is really about the WIRING — and it meant a pre-0063 row whose id was anchored on
 * its area could never be found by a caller reasoning about devices. The uniqueness this leans on
 * is real: `derivation_sources_signal_role_unique` for a run-detector, the PK for the rest.
 */
export async function findDerivationBySource(
  db: DerivationSourceExec,
  kind: string,
  role: string | null,
  slot: string,
  pointId: string,
): Promise<string | null> {
  const conds = [
    eq(derivationSources.kind, kind),
    eq(derivationSources.slot, slot),
    eq(derivationSources.pointId, pointId),
  ];
  if (role !== null) conds.push(eq(derivationSources.role, role));
  const [row] = await db
    .select({ derivationId: derivationSources.derivationId })
    .from(derivationSources)
    .where(and(...conds))
    .limit(1);
  return row?.derivationId ?? null;
}
