import { NextRequest, NextResponse } from "next/server";
import { revalidatePath } from "next/cache";
import { requireSystemAccess } from "@/lib/api-auth";
import { SystemsManager } from "@/lib/systems-manager";
import { derivedCapabilitiesForSystem } from "@/lib/capabilities/server";
import { CAPABILITIES, type CapabilityId } from "@/lib/capabilities/registry";
import type { DeviceConfig } from "@/lib/capabilities/config";

// Per-device CONFIG endpoint — reads/writes the typed `systems.config` (DeviceConfig) jsonb blob that
// data-drives capability on/off overrides + nameplateKw + updateCadenceSeconds (see
// lib/capabilities/config.ts). Owner/admin editable (requireSystemAccess), so it lives alongside the
// other per-system settings routes but is NOT admin-only. The whole blob is the DeviceConfig, so PATCH
// REPLACES it with the cleaned config the configurator sends (empty → null), rather than shallow-merging
// (that's how a toggle set back to "default" removes its key).

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

function isCapabilityId(key: string): key is CapabilityId {
  return Object.prototype.hasOwnProperty.call(CAPABILITIES, key);
}

// Validate + clean an incoming DeviceConfig. Returns the cleaned config (all-default → null) or an error.
function parseDeviceConfig(
  body: unknown,
): { config: DeviceConfig | null } | { error: string } {
  if (!isPlainObject(body)) return { error: "Body must be a JSON object" };

  const out: DeviceConfig = {};

  if (body.capabilities !== undefined && body.capabilities !== null) {
    if (!isPlainObject(body.capabilities))
      return { error: "`capabilities` must be an object" };
    const caps: Partial<Record<CapabilityId, boolean>> = {};
    for (const [key, value] of Object.entries(body.capabilities)) {
      if (!isCapabilityId(key)) return { error: `Unknown capability: ${key}` };
      if (typeof value !== "boolean")
        return { error: `Capability ${key} must be a boolean` };
      caps[key] = value;
    }
    if (Object.keys(caps).length > 0) out.capabilities = caps;
  }

  for (const field of ["nameplateKw", "updateCadenceSeconds"] as const) {
    const v = body[field];
    if (v === undefined || v === null) continue;
    if (typeof v !== "number" || !Number.isFinite(v) || v <= 0)
      return { error: `\`${field}\` must be a positive number` };
    out[field] = v;
  }

  return { config: Object.keys(out).length > 0 ? out : null };
}

export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ systemId: string }> },
) {
  const { systemId: systemIdStr } = await params;
  const systemId = parseInt(systemIdStr);
  if (isNaN(systemId))
    return NextResponse.json({ error: "Invalid system ID" }, { status: 400 });

  const auth = await requireSystemAccess(request, systemId);
  if (auth instanceof NextResponse) return auth;

  // `derived` is the capability set BEFORE this device's own overrides — the "Default" baseline the
  // configurator annotates each toggle with.
  const derived = await derivedCapabilitiesForSystem(systemId);
  return NextResponse.json({
    success: true,
    config: auth.system.config ?? {},
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

  const auth = await requireSystemAccess(request, systemId, {
    requireWrite: true,
  });
  if (auth instanceof NextResponse) return auth;

  const body = await request.json().catch(() => null);
  const parsed = parseDeviceConfig(body);
  if ("error" in parsed)
    return NextResponse.json({ error: parsed.error }, { status: 400 });

  await SystemsManager.getInstance().updateSystem(systemId, {
    config: parsed.config,
  });

  // Capability eligibility is server-rendered (device viewer + dashboard seeds); refresh it.
  revalidatePath("/dashboard", "layout");
  revalidatePath("/device", "layout");

  return NextResponse.json({ success: true, config: parsed.config });
}
