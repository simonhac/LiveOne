/**
 * Request-scoped cache of the raw SPARSE `point_readings_agg_5m` `avg` rows the `/api/history` "fetch"
 * span already read (`fetchAggRowsPg`), so the "attr" span (`buildAttributedFlowMatrix` → the
 * flow-series read) can reuse the in-window rows instead of re-querying the same table for the same
 * role points (roadmap §1.3a). A pure DB-read elimination — the reconstructed row SET is byte-identical
 * to today's single query, so the attributed matrix and fold state are unchanged.
 *
 * Stores fetch's **pre-densify** rows: a densify-null (a grid slot with no stored row) is
 * indistinguishable from a stored `avg = null` row, and conflating them would inject phantom intervals
 * into the sparse fold timeline. Keyed by `${systemId}.${pointId}`, with the queried window `[from, to]`
 * and the queried point-set recorded so the consumer can query only the pre-window lead-in
 * `[startMs, from)` and skip points fetch never read.
 */

/** The subset of a `fetchAggRowsPg` result row this cache needs (extra columns are ignored). */
export interface Agg5mAvgRow {
  pointId: number;
  intervalEnd: Date;
  avg: number | null;
}

export interface Agg5mSlice {
  /** True iff fetch queried this `(systemId, pointId)` AND the cache window reaches `endMs`. */
  covered: boolean;
  /** The cache window's lower bound — the caller queries only `[startMs, from)` as lead-in. */
  from: number;
  /** Cached rows filtered to `[startMs, endMs]` (inclusive). */
  rows: { t: number; avg: number | null }[];
}

export class Agg5mAvgCache {
  private from?: number;
  private to?: number;
  private readonly queried = new Set<string>();
  private readonly rowsByPoint = new Map<
    string,
    { t: number; avg: number | null }[]
  >();

  private static key(systemId: number, pointId: number): string {
    return `${systemId}.${pointId}`;
  }

  /**
   * Record fetch's raw sparse rows for `pointIds` of `systemId`, queried over `[from, to]` inclusive.
   * Every queried point is marked covered (even with zero matching rows). All records in one request
   * share the same window — fetch queries every system over the same `[queryFirstEpoch, lastEpoch]`.
   */
  record(
    systemId: number,
    pointIds: readonly number[],
    from: number,
    to: number,
    res: readonly Agg5mAvgRow[],
  ): void {
    this.from = from;
    this.to = to;
    for (const id of pointIds) {
      const k = Agg5mAvgCache.key(systemId, id);
      this.queried.add(k);
      if (!this.rowsByPoint.has(k)) this.rowsByPoint.set(k, []);
    }
    for (const r of res) {
      const arr = this.rowsByPoint.get(Agg5mAvgCache.key(systemId, r.pointId));
      if (arr) arr.push({ t: r.intervalEnd.getTime(), avg: r.avg });
    }
  }

  /**
   * The in-window rows for `(systemId, pointId)` over `[startMs, endMs]`, IF fetch queried that pair
   * and the cache window reaches `endMs`. Fail-safe: any tail gap (`to < endMs`) or an unqueried point
   * returns `covered:false`, so the caller issues a full `[startMs, endMs]` query — never under-reads.
   */
  slice(
    systemId: number,
    pointId: number,
    startMs: number,
    endMs: number,
  ): Agg5mSlice {
    const k = Agg5mAvgCache.key(systemId, pointId);
    if (
      this.from === undefined ||
      this.to === undefined ||
      this.to < endMs ||
      !this.queried.has(k)
    ) {
      return { covered: false, from: startMs, rows: [] };
    }
    const all = this.rowsByPoint.get(k) ?? [];
    const rows = all.filter((r) => r.t >= startMs && r.t <= endMs);
    return { covered: true, from: this.from, rows };
  }
}
