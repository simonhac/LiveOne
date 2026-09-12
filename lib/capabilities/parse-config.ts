/**
 * `parseDeviceConfig` — validate and CLEAN an incoming `DeviceConfig` (`devices.config`).
 *
 * EXTRACTED from `app/api/admin/devices/[systemId]/config/route.ts`, which still re-exports it so
 * that route's behaviour is unchanged. It lives here because it now has three callers and two of
 * them are not routes: `PATCH /api/v4/devices/{id}/config` (the CLI's writer) and
 * `liveone device config lint`, which needs the parser WITHOUT `next/server` and `revalidatePath`
 * coming with it — a CLI cannot import from an `app/api/**​/route.ts` without dragging the whole
 * Next server runtime in.
 *
 * 🛑 **This is a WHITELIST REBUILD, not a merge.** It starts from `{}` and copies across only the
 * keys named below, so any key it does not name is silently DROPPED — and the PATCH that calls it
 * REPLACES the whole column. That is a feature and a loaded gun in one:
 *
 *   - It is how a deleted config key is evicted from storage. `exportTariff` (deleted by #481, which
 *     shipped no data sweep) leaves `devices.config` the first time a config is saved through here,
 *     which is the entire mechanism behind `liveone device config clean`.
 *   - It is also how a LIVE field gets destroyed if someone adds it to `DeviceConfig` and forgets to
 *     add it here. That has happened twice: `spec` and `batteryProvenance` (fixed in #480), then
 *     `reserveFloorMaxPct` (fixed in #481). Both were found by the total round-trip test, not by use.
 *
 * So: **add a new `DeviceConfig` field to this function AND to `FULL_CONFIG` in
 * `app/api/admin/__tests__/device-config-route.test.ts` in the same change.** The test feeds a GET's
 * body straight back into a PATCH and asserts the two are equal; a field that does not survive that
 * round trip is the bug it exists to catch.
 */
import { CAPABILITIES, type CapabilityId } from "@/lib/capabilities/registry";
import type {
  DeviceConfig,
  DeviceSpec,
  BatteryProvenanceConfig,
} from "@/lib/capabilities/config";

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

/** Validate + clean an incoming DeviceConfig. Returns the cleaned config (all-default → null) or an error. */
export function parseDeviceConfig(
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

/**
 * The dotted paths `parseDeviceConfig` would DROP from a stored blob — i.e. the rot.
 *
 * Computed structurally (walk the stored object, walk the parsed object, diff the leaf paths) rather
 * than from a hard-coded list of retired keys, because the point is to catch the NEXT deleted key
 * without anyone remembering to add it here. A path is reported when the stored blob has a leaf the
 * parser's output does not.
 *
 * Values that merely CHANGE (a normalised `renewableFraction` defaulting to 0, say) are not drops and
 * are not reported — this answers "what would be lost", not "what would differ".
 */
export function droppedConfigPaths(stored: unknown): string[] {
  const parsed = parseDeviceConfig(stored);
  // A stored blob the parser REJECTS has nothing to drop — it has something to fix, which is a
  // different finding and is reported by the caller from `parseDeviceConfig`'s own error.
  if ("error" in parsed) return [];
  const after = (parsed.config ?? {}) as unknown;

  const out: string[] = [];
  const walk = (a: unknown, b: unknown, path: string) => {
    if (!isPlainObject(a)) {
      if (b === undefined) out.push(path);
      return;
    }
    for (const [k, v] of Object.entries(a)) {
      const next = path ? `${path}.${k}` : k;
      const bv = isPlainObject(b) ? b[k] : undefined;
      if (isPlainObject(v)) walk(v, bv, next);
      else if (bv === undefined) out.push(next);
    }
  };
  walk(stored, after, "");
  return out.sort();
}
