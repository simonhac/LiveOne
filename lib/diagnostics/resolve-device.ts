/**
 * Resolve a `dv_…` path segment to the `(uuid, rid)` pair the diagnostics routes need.
 *
 * Deliberately identity-only: whether the caller may SEE the device is `requireDeviceAccess`'s
 * question, and answering it here as well would be two places to get it wrong.
 */
import { NextResponse } from "next/server";
import { eq } from "drizzle-orm";
import { requirePlanetscaleDb } from "@/lib/db/planetscale";
import { devices as devicesTable } from "@/lib/db/planetscale/schema";
import { Device } from "@/lib/ids";

export async function resolveDeviceParam(
  params: Promise<{ id: string }>,
): Promise<{ uuid: string; systemId: number } | { error: NextResponse }> {
  const { id } = await params;
  const uuid = Device.toUuidOrNull(id);
  if (!uuid)
    return {
      error: NextResponse.json({ error: "Invalid device id" }, { status: 400 }),
    };
  const db = requirePlanetscaleDb();
  const [row] = await db
    .select({ rid: devicesTable.rid })
    .from(devicesTable)
    .where(eq(devicesTable.id, uuid))
    .limit(1);
  if (!row)
    return {
      error: NextResponse.json({ error: "Device not found" }, { status: 404 }),
    };
  return { uuid, systemId: row.rid };
}
