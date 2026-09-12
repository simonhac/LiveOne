import { NextRequest, NextResponse } from "next/server";
import { revalidatePath } from "next/cache";
import { requireDeviceAccess } from "@/lib/api-auth";
import { DeviceWriter } from "@/lib/registry/device-writer";
import { derivedCapabilitiesForDevice } from "@/lib/capabilities/server";
import { parseDeviceConfig } from "@/lib/capabilities/parse-config";
import { syncAreaBatteryConfigFromDevice } from "@/lib/areas/config";

// Per-device CONFIG endpoint — reads/writes the typed `systems.config` (DeviceConfig) jsonb blob that
// data-drives capability on/off overrides + nameplateKw + updateCadenceSeconds (see
// lib/capabilities/config.ts). Owner/admin editable (requireDeviceAccess), so it lives alongside the
// other per-device settings routes but is NOT admin-only. The whole blob is the DeviceConfig, so PATCH
// REPLACES it with the cleaned config the configurator sends (empty → null), rather than shallow-merging
// (that's how a toggle set back to "default" removes its key).
//
// The parser itself now lives in `lib/capabilities/parse-config.ts` — it has two non-route callers
// (the v4 config PATCH and `liveone device config lint`), and a CLI cannot import from a route
// module without dragging `next/server` in with it. Behaviour here is unchanged.

export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ systemId: string }> },
) {
  const { systemId: systemIdStr } = await params;
  const systemId = parseInt(systemIdStr);
  if (isNaN(systemId))
    return NextResponse.json({ error: "Invalid system ID" }, { status: 400 });

  const auth = await requireDeviceAccess(request, systemId);
  if (auth instanceof NextResponse) return auth;

  // `derived` is the capability set BEFORE this device's own overrides — the "Default" baseline the
  // configurator annotates each toggle with.
  const derived = await derivedCapabilitiesForDevice(systemId);
  return NextResponse.json({
    success: true,
    config: auth.device.config ?? {},
    derived: [...derived],
  });
}

export async function PATCH(
  request: NextRequest,
  { params }: { params: Promise<{ systemId: string }> },
) {
  const { systemId: systemIdStr } = await params;
  const systemId = parseInt(systemIdStr);
  if (isNaN(systemId))
    return NextResponse.json({ error: "Invalid system ID" }, { status: 400 });

  const auth = await requireDeviceAccess(request, systemId, {
    requireWrite: true,
  });
  if (auth instanceof NextResponse) return auth;

  const body = await request.json().catch(() => null);
  const parsed = parseDeviceConfig(body);
  if ("error" in parsed)
    return NextResponse.json({ error: parsed.error }, { status: 400 });

  await DeviceWriter.updateDevice(systemId, {
    config: parsed.config,
  });
  await syncAreaBatteryConfigFromDevice(
    systemId,
    parsed.config?.batteryProvenance,
  );

  // Capability eligibility is server-rendered (device viewer + dashboard seeds); refresh it.
  revalidatePath("/dashboard", "layout");
  revalidatePath("/device", "layout");

  return NextResponse.json({ success: true, config: parsed.config });
}
