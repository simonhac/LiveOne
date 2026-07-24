import type { ActivePointLatest } from "@/lib/readings";
import type { PointAddr } from "@/lib/registry";

export function groupLatestBySystem(
  rows: ActivePointLatest[],
  addresses: ReadonlyMap<ActivePointLatest["point"], PointAddr>,
): Map<number, ActivePointLatest[]> {
  const bySystem = new Map<number, ActivePointLatest[]>();
  for (const row of rows) {
    const address = addresses.get(row.point);
    if (!address) throw new Error(`Missing point address for ${row.point}`);
    const list = bySystem.get(address.systemId) ?? [];
    list.push(row);
    bySystem.set(address.systemId, list);
  }
  return bySystem;
}
