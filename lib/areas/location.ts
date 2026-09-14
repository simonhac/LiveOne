/**
 * Merge semantics for editing an Area's `location` (the `AreaLocation` jsonb that DERIVES the NEM
 * grid region — see lib/vendors/openelectricity/region.ts). Generalises the merge in
 * scripts/set-area-location.ts so the location-editor API and the script agree.
 *
 * A patch is applied field-by-field:
 *   - key absent           → preserve the existing value (don't clobber lat/lng you didn't touch)
 *   - key present, value   → set it (country/state upper-cased, like the region resolver expects)
 *   - key present, ""/null → clear it (remove from the stored object)
 * `country` defaults to "AU" when the result would otherwise have none (the NEM is AU-only).
 */
import type { AreaLocation } from "@/lib/areas/types";

export interface AreaLocationPatch {
  country?: string | null;
  state?: string | null;
  postcode?: string | null;
  lat?: number | null;
  lng?: number | null;
}

/** Validate an HTTP location patch before coercion can silently discard invalid fields. */
export function areaLocationPatchError(
  body: unknown,
  existing: AreaLocation | null,
): string | null {
  if (!body || typeof body !== "object" || Array.isArray(body))
    return "location must be an object";
  const patch = body as Record<string, unknown>;
  for (const key of ["country", "state", "postcode"] as const) {
    const value = patch[key];
    if (value !== undefined && value !== null && typeof value !== "string")
      return `location.${key} must be a string or null`;
  }
  for (const [key, limit] of [
    ["lat", 90],
    ["lng", 180],
  ] as const) {
    const value = patch[key];
    if (
      value !== undefined &&
      value !== null &&
      (typeof value !== "number" ||
        !Number.isFinite(value) ||
        Math.abs(value) > limit)
    )
      return `location.${key} must be between -${limit} and ${limit}, or null`;
  }
  const country =
    patch.country === undefined
      ? (existing?.country ?? "AU")
      : typeof patch.country === "string"
        ? patch.country.trim().toUpperCase() || "AU"
        : "AU";
  if (!/^[A-Z]{2}$/.test(country))
    return "location.country must be a two-letter country code";
  if (country === "AU") {
    const state =
      typeof patch.state === "string" ? patch.state.trim().toUpperCase() : "";
    if (
      state &&
      !["NSW", "ACT", "VIC", "QLD", "SA", "TAS", "WA", "NT"].includes(state)
    )
      return "location.state must be an Australian state or territory code";
    const postcode =
      typeof patch.postcode === "string" ? patch.postcode.trim() : "";
    if (postcode && !/^\d{4}$/.test(postcode))
      return "location.postcode must contain four digits";
  }
  return null;
}

export function mergeAreaLocation(
  existing: AreaLocation | null | undefined,
  patch: AreaLocationPatch,
): AreaLocation {
  const out: Partial<AreaLocation> = { ...(existing ?? {}) };

  const applyStr = (
    key: "country" | "state" | "postcode",
    val: string | null | undefined,
    upper: boolean,
  ): void => {
    if (val === undefined) return; // preserve
    const s = typeof val === "string" ? val.trim() : "";
    if (!s) {
      delete out[key]; // clear
      return;
    }
    out[key] = upper ? s.toUpperCase() : s;
  };
  applyStr("country", patch.country, true);
  applyStr("state", patch.state, true);
  applyStr("postcode", patch.postcode, false);

  const applyNum = (
    key: "lat" | "lng",
    val: number | null | undefined,
  ): void => {
    if (val === undefined) return; // preserve
    if (val === null || !Number.isFinite(val)) {
      delete out[key]; // clear
      return;
    }
    out[key] = val;
  };
  applyNum("lat", patch.lat);
  applyNum("lng", patch.lng);

  // country is required on AreaLocation; the NEM is AU-only, so default it.
  return { ...out, country: out.country || "AU" };
}
