/**
 * How an area-wiring change is stated to an operator.
 *
 * 🛑 `renderDiff` is not decoration. The routes replace whole collections, so what an operator most
 * needs to see is what they are about to KEEP — a kept-count that moves when it should not is the
 * cheapest way to catch a read-modify-write that dropped something.
 */
import type { PointCandidate, WireBinding } from "./model";

export const slotOf = (b: WireBinding) => `${b.role}/${b.metricType}`;

/**
 * State a write as a DIFF against what is already there.
 *
 * The routes replace whole collections, so the thing an operator most needs to see is not what they
 * asked for — it is what they are about to keep. A count that changes when it should not is the
 * only cheap way to catch a read-modify-write that dropped something.
 */
export function renderDiff(
  label: string,
  before: string[],
  after: string[],
): string[] {
  const kept = after.filter((x) => before.includes(x));
  const added = after.filter((x) => !before.includes(x));
  const removed = before.filter((x) => !after.includes(x));
  const out = [
    `${label}: ${before.length} → ${after.length}` +
      `  (${kept.length} kept, ${added.length} added, ${removed.length} removed)`,
  ];
  for (const x of added) out.push(`   + ${x}`);
  for (const x of removed) out.push(`   - ${x}`);
  if (!added.length && !removed.length) out.push("   (no change)");
  return out;
}

export function describeBinding(
  b: WireBinding,
  pool: PointCandidate[],
  chainRank?: number,
): string {
  const p = pool.find((x) => x.id === b.pointId);
  // Annotated only for a binding that is actually IN a chain. Two circuits in one slot are not a
  // chain and printing "serves" against each would suggest a competition they are not in.
  const chain =
    chainRank === undefined
      ? ""
      : chainRank === 0
        ? "  [serves]"
        : `  [fallback ${chainRank}]`;
  return (
    `${slotOf(b).padEnd(26)} prio ${String(b.priority).padEnd(3)} ` +
    (p ? `${p.deviceName}:${p.logicalPath}` : b.pointId) +
    chain
  );
}

/**
 * Which bindings are in a fallback chain, and where — keyed by `pointId`.
 *
 * A chain is bindings sharing a SERVING KEY (`{logical_path}/{metric_type}`), which is what the
 * server ranks (`lib/areas/binding-chain.ts`); different paths in one slot are circuits, not rivals.
 * Computed from the wire's own `priority` rather than asked for, so `role list` reads the same
 * authored order the server does — but note it cannot see `points.active`, which the server ranks
 * ahead of priority. An inactive preferred point therefore prints `[serves]` while the server has
 * already promoted the one below it; `liveone area resolution` is the authority on that.
 */
export function chainRanks(
  bindings: WireBinding[],
  pool: PointCandidate[],
): Map<string, number> {
  const byKey = new Map<string, WireBinding[]>();
  for (const b of bindings) {
    const p = pool.find((x) => x.id === b.pointId);
    if (!p) continue;
    const key = `${p.logicalPath}/${p.metricType}`;
    const list = byKey.get(key);
    if (list) list.push(b);
    else byKey.set(key, [b]);
  }
  const ranks = new Map<string, number>();
  for (const list of byKey.values()) {
    if (list.length < 2) continue;
    [...list]
      .sort((a, b) => a.priority - b.priority)
      .forEach((b, rank) => ranks.set(b.pointId, rank));
  }
  return ranks;
}
