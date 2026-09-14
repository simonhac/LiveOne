import { NextRequest, NextResponse } from "next/server";
import { eq } from "drizzle-orm";
import { requireAuth } from "@/lib/api-auth";
import { requirePlanetscaleDb } from "@/lib/db/planetscale";
import { devices } from "@/lib/db/planetscale/schema";
import { Device } from "@/lib/ids";
import { getDeviceCredentials } from "@/lib/secure-credentials";
import { readAmberIdentity } from "@/lib/vendors/amber/device-name";

/** CLI identity lookup. Owner/admin only: vendor credentials never leave the server.
 * Already covered by the devices CLI route matcher; no admin-route bypass is needed.
 * GET only reads vendor metadata, and neither polls nor changes the device or its area.
 */
export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const auth = await requireAuth(request);
  if (auth instanceof NextResponse) return auth;
  const { id } = await params;
  const uuid = Device.toUuidOrNull(id);
  if (!uuid)
    return NextResponse.json({ error: "Invalid device id" }, { status: 400 });
  const [device] = await requirePlanetscaleDb()
    .select({
      rid: devices.rid,
      ownerUserId: devices.ownerUserId,
      vendor: devices.vendor,
      vendorSiteId: devices.vendorSiteId,
    })
    .from(devices)
    .where(eq(devices.id, uuid))
    .limit(1);
  if (!device || !(auth.actingAsAdmin || device.ownerUserId === auth.userId))
    return NextResponse.json({ error: "Device not found" }, { status: 404 });
  if (device.vendor !== "amber")
    return NextResponse.json(
      { error: "Vendor identity lookup currently supports Amber only" },
      { status: 422 },
    );
  if (!device.ownerUserId || !device.vendorSiteId)
    return NextResponse.json(
      { error: "Device has no owner or vendor site" },
      { status: 422 },
    );
  const credentials = await getDeviceCredentials(
    device.ownerUserId,
    device.rid,
  );
  if (
    !credentials ||
    typeof credentials.apiKey !== "string" ||
    !credentials.apiKey
  )
    return NextResponse.json(
      { error: "Amber credentials are missing" },
      { status: 422 },
    );
  try {
    const identity = await readAmberIdentity(
      credentials.apiKey,
      device.vendorSiteId,
    );
    return NextResponse.json({ id, vendor: device.vendor, ...identity });
  } catch {
    // Do not echo upstream payloads, URLs or credentials into CLI output.
    return NextResponse.json(
      { error: "Could not verify the stored site's identity with Amber" },
      { status: 502 },
    );
  }
}
