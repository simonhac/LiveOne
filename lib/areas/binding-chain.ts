/**
 * Binding chains — the one definition of what `area_bindings.priority` MEANS.
 *
 * `priority` is documented on the column as "scoped to one (area, role, metric) slot … Lowest wins",
 * and `liveone area role set` advertises that naming several points "sets the slot's whole priority
 * order in one write, which is how a fallback chain is expressed". Until this module existed exactly
 * one reader honoured it — `resolveSlotsFromData`, wired only to the read-only
 * `GET /api/v4/areas/{id}/resolution` report. Every path that actually SERVES data
 * (`PointManager._resolvePointsForHandle` → history/charts/flow, and the KV subscription registry)
 * took the bindings as an unordered SET, so two bindings that collided produced a coin flip rather
 * than a chain. That is not hypothetical: binding device 6 and device 5 to Kinkora's `battery/soc`
 * slot made the same request answer "304/304 days" and "81/304 days" on consecutive calls, because
 * both points minted the byte-identical series id `8/bidi.battery/soc.last` and whichever landed
 * last in `site-data-processor`'s `seriesMap.set(s.id, s)` won.
 *
 * ## What contends
 *
 * The contention set is NOT the (role, metric) slot. A slot legitimately holds several points with
 * different paths — Kinkora's `load` slot binds `load.hvac/power`, `load.pool/power`, `load.ev/power`
 * … and every one of them must serve, because they are different circuits. What collides is the
 * **serving key**: `"{logical_path}/{metric_type}"`, the string that is simultaneously the latest
 * hash's field name and the middle of the series id. Two bindings sharing THAT are two instruments
 * measuring one quantity, and exactly one of them can be the area's answer.
 *
 * So: distinct serving keys all serve; within one serving key, priority orders a chain.
 *
 * ## Rank
 *
 * `rank` 0 is the serving winner; 1, 2, … are fallbacks, kept rather than discarded — the live map
 * publishes them under a suffixed field so a reader can fall back when the winner goes stale (see
 * `lib/latest-values-store.ts`). History and the flow builder take rank 0 only: a stored series has
 * one provenance, and stitching two instruments into one series id would make that id a lie.
 *
 * The comparator is `active` first, then `priority`, then `ordinal`, then the uuid:
 *  - **active first** because an inactive point cannot produce a reading, so letting it hold rank 0
 *    would cost the area the whole path — the chain's entire job is to survive that.
 *  - **priority** is the authored intent, lowest wins (the column's own rule).
 *  - **ordinal then uuid** are tiebreaks, and they are what make this deterministic rather than
 *    merely usually-right. `area_bindings_slot_priority_unique` makes priority unique per
 *    (area, role, metric) — but a serving key is not a slot, so two bindings in DIFFERENT roles
 *    could in principle share a path at the same priority. Nothing orders those but these.
 */

/** The identity two bindings contend over. Null for a stemless point, which claims no path at all. */
export function servingKey(
  logicalPath: string | null,
  metricType: string,
): string | null {
  return logicalPath === null ? null : `${logicalPath}/${metricType}`;
}

/** What ranking needs from a binding. Readers pass their own row type and get it back. */
export interface ChainCandidate {
  /** `points.id` — the final tiebreak, so the order never depends on row arrival. */
  pointUid: string;
  /** `points.logical_path`; null ⇒ stemless ⇒ uncontendable. */
  logicalPath: string | null;
  /** `points.metric_type` (identical to `area_bindings.metric_type`). */
  metricType: string;
  /** `area_bindings.priority` — lowest wins. */
  priority: number;
  /** `area_bindings.ordinal` — tiebreak only. */
  ordinal: number;
  /** `points.active`. An inactive point is ranked behind every active one. */
  active: boolean;
}

export interface Ranked<T> {
  item: T;
  /** 0 = serves the path; ≥1 = fallback, in order. */
  rank: number;
  /** The contended serving key, or null for a stemless point (always rank 0). */
  key: string | null;
}

/**
 * Rank one Area's bindings into chains. Input order is irrelevant; output is sorted by chain then
 * rank, so callers that log or persist it get a stable diff.
 *
 * Pass ONE area's bindings. Priority is area-scoped, so mixing areas would rank across them.
 */
export function rankBindingChains<T extends ChainCandidate>(
  candidates: readonly T[],
): Ranked<T>[] {
  const byKey = new Map<string, T[]>();
  const stemless: T[] = [];
  for (const candidate of candidates) {
    const key = servingKey(candidate.logicalPath, candidate.metricType);
    if (key === null) {
      stemless.push(candidate);
      continue;
    }
    const group = byKey.get(key);
    if (group) group.push(candidate);
    else byKey.set(key, [candidate]);
  }

  const out: Ranked<T>[] = [];
  for (const key of [...byKey.keys()].sort()) {
    const group = byKey.get(key)!.sort(compareChain);
    group.forEach((item, rank) => out.push({ item, rank, key }));
  }
  for (const item of stemless.sort(compareChain)) {
    out.push({ item, rank: 0, key: null });
  }
  return out;
}

function compareChain(a: ChainCandidate, b: ChainCandidate): number {
  if (a.active !== b.active) return a.active ? -1 : 1;
  return (
    a.priority - b.priority ||
    a.ordinal - b.ordinal ||
    a.pointUid.localeCompare(b.pointUid)
  );
}

/** The rank-0 members — the points an Area actually serves. */
export function chainWinners<T extends ChainCandidate>(
  candidates: readonly T[],
): T[] {
  return rankBindingChains(candidates)
    .filter((r) => r.rank === 0)
    .map((r) => r.item);
}
