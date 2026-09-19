/**
 * Per-area run provenance — the one place a run's cost, carbon and renewable share are read for a
 * NAMED area, shared by the runs table (`/api/device/[systemId]/run-periods`) and the area calendar
 * feed so the two can never price the same run differently.
 */
import { and, eq, inArray } from "drizzle-orm";
import { requirePlanetscaleDb } from "@/lib/db/planetscale";
import {
  derivedIntervalProvenance,
  type DerivedInterval,
} from "@/lib/db/planetscale/schema";

/**
 * Overlay THE VIEWING AREA'S provenance onto run rows.
 *
 * A run's cost, carbon and renewable share are area-relative — the same Kutis EV session is 17.9c
 * through High Street Kew, which binds the Amber meter, and unpriceable through the Kutis
 * area-of-one, which does not — so they live per-area in `derived_interval_provenance`, and every
 * reader names the area it is answering for: the runs table the area being VIEWED (`{systemId}` is a
 * handle, and the stacked chart passes the composite's), the calendar feed the area it belongs to.
 *
 * Falls back to the row's own legacy columns where the sidecar has no row. Two cases, and the
 * fallback is right for both: a run recomputed before migration 0066 has no sidecar row yet (the
 * legacy column is the only answer there is until the backfill reaches it), and an area that cannot
 * price a run has no row BY DESIGN — where the legacy column is then NULL too, because the writer
 * refuses to fill it when more than one area could answer. Either way "no row" resolves to the most
 * honest number available rather than to a fabricated zero.
 */
export async function withAreaProvenance<T extends DerivedInterval>(
  rows: T[],
  derivationId: string,
  areaId: string | null,
): Promise<T[]> {
  if (areaId === null || rows.length === 0) return rows;
  const db = requirePlanetscaleDb();
  const prov = await db
    .select({
      startTime: derivedIntervalProvenance.startTime,
      costC: derivedIntervalProvenance.costC,
      emissionsG: derivedIntervalProvenance.emissionsG,
      renewableKwh: derivedIntervalProvenance.renewableKwh,
      estimatedKwh: derivedIntervalProvenance.estimatedKwh,
    })
    .from(derivedIntervalProvenance)
    .where(
      and(
        eq(derivedIntervalProvenance.derivationId, derivationId),
        eq(derivedIntervalProvenance.areaId, areaId),
        inArray(
          derivedIntervalProvenance.startTime,
          rows.map((r) => r.startTime),
        ),
      ),
    );
  if (prov.length === 0) return rows;
  const byStart = new Map(prov.map((p) => [p.startTime.getTime(), p]));
  return rows.map((r) => {
    const p = byStart.get(r.startTime.getTime());
    // Whole-row substitution, never field-by-field: the four numbers are ONE verdict about one run
    // seen from one place (`estimatedKwh` is the confidence denominator for the other three), so
    // mixing this area's cost with another's estimate would produce a figure no area ever computed.
    return p
      ? {
          ...r,
          costC: p.costC,
          emissionsG: p.emissionsG,
          renewableKwh: p.renewableKwh,
          estimatedKwh: p.estimatedKwh,
        }
      : r;
  });
}
