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
): string {
  const p = pool.find((x) => x.id === b.pointId);
  return (
    `${slotOf(b).padEnd(26)} prio ${String(b.priority).padEnd(3)} ` +
    (p ? `${p.deviceName}:${p.logicalPath}` : b.pointId)
  );
}
