import type { ActivePointLatest } from "@/lib/readings";
import type { PointAddr } from "@/lib/registry";

export function groupLatestByDevice(
  rows: ActivePointLatest[],
  addresses: ReadonlyMap<ActivePointLatest["point"], PointAddr>,
): Map<number, ActivePointLatest[]> {
  const byDevice = new Map<number, ActivePointLatest[]>();
  for (const row of rows) {
    const address = addresses.get(row.point);
    if (!address) throw new Error(`Missing point address for ${row.point}`);
    const list = byDevice.get(address.systemId) ?? [];
    list.push(row);
    byDevice.set(address.systemId, list);
  }
  return byDevice;
}
