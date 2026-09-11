/**
 * Waiting for published observations to LAND — the step between "put on the wire" and "safe to read
 * back".
 *
 * 🛑 **The failure this exists to prevent is silent and permanent.** Observations are published to a
 * queue and applied asynchronously, so anything that recomputes FROM them — `agg_1d`, a flow matrix —
 * must wait first or it reads a half-applied store and writes the half. The result is a day that is
 * wrong, internally consistent, and invisible: nothing downstream recomputes a past day on its own,
 * so it simply stays wrong. Kutis' 2026-09-09 daily totals sat at solar 0 Wh and load 1,860 Wh
 * against 5-minute rows summing to 35,330 and 20,210 until someone compared the two by hand.
 *
 * 🛑 **"Something arrived" is not "everything arrived", and the gap is enormous.** Both waits in this
 * codebase originally stopped on a sign of life — `MAX(updated_at)` advancing past a baseline in the
 * Sigenergy backfill, `present > pre` in the coverage runner. A 7-day Sigenergy window is ~12k
 * observations, chunked at 500 per message and delivered at lane parallelism 2: the first row lands
 * within a second and the last tens of seconds later, so a sign-of-life test passes almost
 * immediately and then keeps passing for the entire delivery. It is not a race that is usually won —
 * it is a check that is almost always wrong, and was masked only because the recompute that followed
 * used to be slow enough to let delivery finish.
 *
 * The publisher always knows how many DISTINCT rows it sent (the poll collector de-duplicates by
 * address), so the honest stop condition is a count, and that is what this waits for.
 *
 * 🛑 **The count must be of OUR rows, which is why the scope carries session ids.** Counting "rows
 * updated since a pre-flush baseline" looks equivalent and is not: it cannot tell our landings from
 * anyone else's, and the slack is not small merely because the batch is large — what matters is the
 * number of rows still OUTSTANDING, so a handful of unrelated writes can stand in for the last
 * handful of queued rows, and those can carry most of a day's energy. The receiver stamps
 * `session_id` onto every row it writes, so the sessions we published under identify our landings
 * exactly, with no baseline and no clock.
 */
import { Point, type PointId } from "@/lib/ids";

/**
 * The exact shape of what one publisher flushed: which points, over which interval range, and how
 * many distinct rows.
 *
 * 🛑 **Derived from the observations themselves, never from a parallel tally.** A caller that counts
 * "everything I collected" but watches only SOME of the points it published to will wait for a
 * number its own query cannot reach, and time out forever. That is not hypothetical: Amber's usage
 * repair publishes energy, cost AND price per channel, while its coverage tails cover only energy and
 * cost — so a complete two-channel day publishes 288 rows and could only ever count 192 of them.
 *
 * The interval range and point set remain as INDEX bounds — correctness comes from `sessionIds`.
 */
export interface LandingScope {
  points: PointId[];
  /** Exclusive lower / inclusive upper bound on `interval_end`, from the published rows. */
  fromMs: number;
  toMs: number;
  /** The sessions these rows were published under — how a landed row is identified as ours. */
  sessionIds: string[];
  /** DISTINCT (point, interval) rows published — the number to wait for. */
  expected: number;
}

/**
 * Read the landing scope off a poll collector's buffer.
 *
 * Only `5m` entries count: they are the ones that become `agg_5m` rows. The collector has already
 * de-duplicated by address, so its length IS the row count — no separate tally can drift from it.
 */
export function landingScopeFor(
  observations: readonly {
    interval: "raw" | "5m" | "1d";
    sessionId: string;
    point: { pointUid: string };
    measurementTimeMs: number;
  }[],
): LandingScope {
  const rows = observations.filter((o) => o.interval === "5m");
  if (rows.length === 0)
    return { points: [], fromMs: 0, toMs: 0, sessionIds: [], expected: 0 };
  const points = [...new Set(rows.map((o) => Point.encode(o.point.pointUid)))];
  const sessionIds = [...new Set(rows.map((o) => o.sessionId))];
  let fromMs = Infinity;
  let toMs = -Infinity;
  for (const o of rows) {
    if (o.measurementTimeMs < fromMs) fromMs = o.measurementTimeMs;
    if (o.measurementTimeMs > toMs) toMs = o.measurementTimeMs;
  }
  // `fromMs` is an EXCLUSIVE lower bound on interval_end downstream, so step back just enough to keep
  // the earliest published row inside the range.
  return {
    points,
    fromMs: fromMs - 1,
    toMs,
    sessionIds,
    expected: rows.length,
  };
}

/** One publisher's claim: `key` published `expected` distinct rows that should become visible. */
export interface LandingTarget {
  key: string;
  expected: number;
}

export interface LandingResult {
  /** Keys whose expected count was observed before the deadline. */
  landed: string[];
  /** Keys that did not reach it. A caller MUST NOT recompute from these. */
  pending: string[];
  /** Last observed count per key, for the report and the log line. */
  observed: Map<string, number>;
  waitedMs: number;
}

export interface WaitForLandingOptions {
  targets: LandingTarget[];
  /**
   * Rows currently visible for `key`. Counting rows another writer touched in the same window is
   * fine and is why the test is `>=`: it can only end the wait early where extra real writes are
   * arriving anyway, unlike a sign-of-life test, which ends it early always.
   *
   * A throw is treated as a transient read failure and retried until the deadline — never as zero,
   * which would restart the wait, and never as success, which would defeat it.
   */
  countLanded: (key: string) => Promise<number>;
  timeoutMs: number;
  pollMs: number;
  sleep?: (ms: number) => Promise<void>;
  now?: () => number;
}

/**
 * Poll `countLanded` until every target reaches its expected count, or the deadline passes.
 *
 * A target expecting 0 rows is landed immediately — nothing was published, so there is nothing to
 * wait for, and holding it to a deadline would stall a run that did no work.
 */
export async function waitForLanding({
  targets,
  countLanded,
  timeoutMs,
  pollMs,
  sleep = (ms) => new Promise((r) => setTimeout(r, ms)),
  now = Date.now,
}: WaitForLandingOptions): Promise<LandingResult> {
  const started = now();
  const observed = new Map<string, number>();
  const landed: string[] = [];
  const awaiting = new Set<string>();

  for (const t of targets) {
    if (t.expected <= 0) landed.push(t.key);
    else awaiting.add(t.key);
  }
  const expectedBy = new Map(targets.map((t) => [t.key, t.expected]));

  // Check BEFORE the first sleep: a small publish is often applied by the time we get here, and
  // sleeping first would add a poll interval to every run for no reason.
  while (awaiting.size > 0) {
    for (const key of [...awaiting]) {
      try {
        const n = await countLanded(key);
        observed.set(key, n);
        if (n >= (expectedBy.get(key) ?? 0)) {
          awaiting.delete(key);
          landed.push(key);
        }
      } catch {
        // Transient — keep waiting; the deadline bounds it.
      }
    }
    if (awaiting.size === 0) break;
    if (now() - started >= timeoutMs) break;
    await sleep(pollMs);
    // Re-check the clock after sleeping, so a deadline that passed DURING the sleep ends the loop
    // rather than buying one more full round of queries.
    if (now() - started >= timeoutMs && awaiting.size > 0) break;
  }

  return {
    landed,
    pending: [...awaiting],
    observed,
    waitedMs: now() - started,
  };
}
