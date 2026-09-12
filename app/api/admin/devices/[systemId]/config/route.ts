import { NextRequest, NextResponse } from "next/server";
import { revalidatePath } from "next/cache";
import { requireDeviceAccess } from "@/lib/api-auth";
import { DeviceWriter } from "@/lib/registry/device-writer";
import { derivedCapabilitiesForDevice } from "@/lib/capabilities/server";
import { CAPABILITIES, type CapabilityId } from "@/lib/capabilities/registry";
import type {
  DeviceConfig,
  DeviceSpec,
  BatteryProvenanceConfig,
} from "@/lib/capabilities/config";
import { syncAreaBatteryConfigFromDevice } from "@/lib/areas/config";

// Per-device CONFIG endpoint — reads/writes the typed `systems.config` (DeviceConfig) jsonb blob that
// data-drives capability on/off overrides + nameplateKw + updateCadenceSeconds (see
// lib/capabilities/config.ts). Owner/admin editable (requireDeviceAccess), so it lives alongside the
// other per-device settings routes but is NOT admin-only. The whole blob is the DeviceConfig, so PATCH
// REPLACES it with the cleaned config the configurator sends (empty → null), rather than shallow-merging
// (that's how a toggle set back to "default" removes its key).

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

function isCapabilityId(key: string): key is CapabilityId {
  return Object.prototype.hasOwnProperty.call(CAPABILITIES, key);
}

// Validate a structured device `spec`. Every field is optional and independently omissible, and each
// must be a POSITIVE finite number: `specFromLegacyText` (lib/capabilities/config.ts) collapses
// non-positive and unparseable alike to `undefined` rather than 0, because an absent spec field has to
// mean exactly what an unparseable free-text value meant — 0 would move the chart's y-axis hint. Take
// the same rule here so a hand-written PATCH cannot introduce a `0` the legacy parse could never produce.
const SPEC_FIELDS = [
  "solarSizeKw",
  "batterySizeKwh",
  "inverterSizeKw",
  "batteryVoltageV",
] as const;

function parseDeviceSpec(
  raw: unknown,
): { value: DeviceSpec | undefined } | { error: string } {
  if (!isPlainObject(raw)) return { error: "`spec` must be an object" };
  const spec: DeviceSpec = {};
  for (const field of SPEC_FIELDS) {
    const v = raw[field];
    if (v === undefined || v === null) continue;
    if (typeof v !== "number" || !Number.isFinite(v) || v <= 0)
      return { error: `\`spec.${field}\` must be a positive number` };
    spec[field] = v;
  }
  // All-absent → undefined, never `spec: {}` — same reason `parseDeviceConfig` returns null for an
  // all-default config: an empty container is noise the reader then has to treat as absent anyway.
  return { value: Object.keys(spec).length > 0 ? spec : undefined };
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

  // 🛑 `spec` MUST be parsed here, because PATCH REPLACES the whole blob (see the module note above).
  // A field this function does not carry through is a field the next save DESTROYS — and `spec`
  // (solarSizeKw/batterySizeKwh, config-v4 slice K1's successor to the free-text `ratings` columns) is
  // not editable anywhere in the UI, so nothing would ever put it back. Kutis carried
  // `{solarSizeKw: 11.9, batterySizeKwh: 32.24}` and one press of Save in the Device Config tab would
  // have erased it silently, taking that chart's y-axis hint (`maxPowerHintFromSpec`) with it.
  if (body.spec !== undefined && body.spec !== null) {
    const parsed = parseDeviceSpec(body.spec);
    if ("error" in parsed) return { error: parsed.error };
    if (parsed.value) out.spec = parsed.value;
  }

  // Battery-provenance config — currently the off-grid generator source intensity.
  if (body.batteryProvenance !== undefined && body.batteryProvenance !== null) {
    if (!isPlainObject(body.batteryProvenance))
      return { error: "`batteryProvenance` must be an object" };
    const bp: BatteryProvenanceConfig = {};
    const gs = body.batteryProvenance.generatorSource;
    if (gs !== undefined && gs !== null) {
      if (!isPlainObject(gs))
        return {
          error: "`batteryProvenance.generatorSource` must be an object",
        };
      const nonNeg = (v: unknown): v is number =>
        typeof v === "number" && Number.isFinite(v) && v >= 0;
      const frac =
        gs.renewableFraction === undefined || gs.renewableFraction === null
          ? 0
          : gs.renewableFraction;
      if (!nonNeg(gs.emissionsIntensity))
        return {
          error:
            "`generatorSource.emissionsIntensity` must be a number ≥ 0 (gCO2/kWh)",
        };
      if (!nonNeg(gs.pricePerKwh))
        return {
          error: "`generatorSource.pricePerKwh` must be a number ≥ 0 (c/kWh)",
        };
      if (
        typeof frac !== "number" ||
        !Number.isFinite(frac) ||
        frac < 0 ||
        frac > 1
      )
        return {
          error: "`generatorSource.renewableFraction` must be between 0 and 1",
        };
      bp.generatorSource = {
        emissionsIntensity: gs.emissionsIntensity,
        pricePerKwh: gs.pricePerKwh,
        renewableFraction: frac,
      };
    }
    // The reserve-floor PRIOR. Unset on every device today, which is exactly why it was missing from
    // this parser and why nothing noticed: a field nobody has set cannot yet be destroyed by a save.
    // Caught by the total round-trip test rather than by use — the same defect class as `spec`.
    const rf = body.batteryProvenance.reserveFloorMaxPct;
    if (rf !== undefined && rf !== null) {
      if (typeof rf !== "number" || !Number.isFinite(rf) || rf < 0 || rf > 100)
        return {
          error: "`batteryProvenance.reserveFloorMaxPct` must be 0..100",
        };
      bp.reserveFloorMaxPct = rf;
    }
    if (Object.keys(bp).length > 0) out.batteryProvenance = bp;
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
