import { NextRequest, NextResponse } from "next/server";
import { revalidatePath } from "next/cache";
import { requireSystemAccess } from "@/lib/api-auth";
import { SystemsManager } from "@/lib/systems-manager";
import { derivedCapabilitiesForSystem } from "@/lib/capabilities/server";
import { CAPABILITIES, type CapabilityId } from "@/lib/capabilities/registry";
import type {
  DeviceConfig,
  BatteryProvenanceConfig,
  ExportTariffConfig,
  ExportTariffPlan,
} from "@/lib/capabilities/config";

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

// Validate an export-tariff config (opportunity-cost source). `none`/`amber` are trivial; a `schedule`
// currently accepts flat plans only (TOU is schema-reserved but the evaluator isn't built — reject early).
function parseExportTariff(
  raw: unknown,
): { value: ExportTariffConfig } | { error: string } {
  if (!isPlainObject(raw)) return { error: "`exportTariff` must be an object" };
  const mode = raw.mode;
  if (mode === "none" || mode === "amber") return { value: { mode } };
  if (mode !== "schedule")
    return {
      error: '`exportTariff.mode` must be "none", "amber" or "schedule"',
    };
  if (!Array.isArray(raw.plans) || raw.plans.length === 0)
    return { error: "`exportTariff.plans` must be a non-empty array" };
  const plans: ExportTariffPlan[] = [];
  for (const p of raw.plans) {
    if (!isPlainObject(p))
      return { error: "each export-tariff plan must be an object" };
    if (
      p.effectiveFrom !== undefined &&
      (typeof p.effectiveFrom !== "string" ||
        !/^\d{4}-\d{2}-\d{2}$/.test(p.effectiveFrom))
    )
      return { error: "`plan.effectiveFrom` must be a YYYY-MM-DD date" };
    if (!isPlainObject(p.rate))
      return { error: "`plan.rate` must be an object" };
    if (p.rate.kind === "tou")
      return { error: "time-of-use export tariffs are not supported yet" };
    if (p.rate.kind !== "flat")
      return { error: '`plan.rate.kind` must be "flat"' };
    if (typeof p.rate.cPerKwh !== "number" || !Number.isFinite(p.rate.cPerKwh))
      return { error: "`flat.cPerKwh` must be a number (c/kWh)" };
    plans.push({
      ...(p.effectiveFrom !== undefined
        ? { effectiveFrom: p.effectiveFrom }
        : {}),
      rate: { kind: "flat", cPerKwh: p.rate.cPerKwh },
    });
  }
  return { value: { mode: "schedule", plans } };
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
    const et = body.batteryProvenance.exportTariff;
    if (et !== undefined && et !== null) {
      const parsed = parseExportTariff(et);
      if ("error" in parsed) return { error: parsed.error };
      bp.exportTariff = parsed.value;
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
