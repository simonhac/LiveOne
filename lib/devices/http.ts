/**
 * `loadDeviceForOwner` — the owner-or-admin gate the device lifecycle verbs share.
 *
 * The device twin of `loadAreaForOwner` (`lib/areas/http.ts`), and it exists for the same reason:
 * three routes (`dependents`, the status PATCH and `DELETE`) each needed the same four steps —
 * authenticate, decode the `dv_` id, read the row, check ownership — and three copies of an
 * authorization check is three places for one of them to drift.
 *
 * 🛑 It reads the device WITHOUT a status filter, deliberately. Every caller here is a lifecycle
 * verb, and an archived device is exactly the one they operate on; `activeOnly` would make the
 * delete unable to see the only devices it is allowed to delete. That is the mirror of the trap
 * `--include-archived` exists for on the area side.
 */
import { NextResponse, type NextRequest } from "next/server";
import { eq } from "drizzle-orm";
import { requireAuth } from "@/lib/api-auth";
import { requirePlanetscaleDb } from "@/lib/db/planetscale";
import { devices } from "@/lib/db/planetscale/schema";
import { Device } from "@/lib/ids";

export interface LoadedDevice {
  uuid: string;
  rid: number;
  name: string;
  status: string;
  ownerUserId: string | null;
}

export async function loadDeviceForOwner(
  request: NextRequest,
  id: string,
): Promise<{ device: LoadedDevice } | { error: NextResponse }> {
  const auth = await requireAuth(request);
  if (auth instanceof NextResponse) return { error: auth };

  const uuid = Device.toUuidOrNull(id);
  if (!uuid)
    return {
      error: NextResponse.json(
        { error: `Invalid device id: ${id}` },
        { status: 400 },
      ),
    };

  const [row] = await requirePlanetscaleDb()
    .select({
      id: devices.id,
      rid: devices.rid,
      name: devices.name,
      status: devices.status,
      ownerUserId: devices.ownerUserId,
    })
    .from(devices)
    .where(eq(devices.id, uuid))
    .limit(1);

  // 🛑 One 404 for "no such device" AND "not yours". Distinguishing them would turn this route into
  // an existence oracle over other people's device ids — the same reason `loadReadableArea` collapses
  // the two.
  if (!row || !(auth.isAdmin || row.ownerUserId === auth.userId))
    return {
      error: NextResponse.json({ error: "Device not found" }, { status: 404 }),
    };

  return {
    device: {
      uuid: row.id,
      rid: row.rid,
      name: row.name,
      status: row.status,
      ownerUserId: row.ownerUserId,
    },
  };
}
