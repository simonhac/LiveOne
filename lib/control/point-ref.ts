/**
 * Resolve a latest-values map entry to the `pt_…` TypeID of the point that produced it.
 *
 * Lives in `lib/` rather than beside its only consumer (`components/TeslaControlDialog.tsx`)
 * because `components/` is NOT a jest root (`jest.config.js` roots: lib/app/scripts/packages),
 * so a test placed there would silently never run. Pure and client-safe: the only import is the
 * `Point` TypeID codec.
 */
import { Point } from "@/lib/ids";

/** The one field this module reads off a latest-map entry. */
type LatestEntryLike = { pointReference?: unknown } | null | undefined;

/**
 * The validated `pt_…` id of a latest-map entry, or null.
 *
 * ⚠️ `pointReference` is PERSISTED in KV and entries written by an older build still carry the
 * pre-config-v4 `"{systemId}.{pointIndex}"` grammar (`lib/latest-values-store.ts`: "readers must
 * treat an unrecognised shape as absent rather than parse it"). So anything that is not a valid
 * `pt_` TypeID — old grammar, wrong prefix, non-string, missing — is ABSENT, never forwarded.
 */
export function pointIdOf(
  latest: Record<string, LatestEntryLike> | null | undefined,
  logicalPath: string,
): string | null {
  const ref = latest?.[logicalPath]?.pointReference;
  if (typeof ref !== "string") return null;
  return Point.parse(ref).ok ? ref : null;
}

/**
 * The three Tesla charge-control targets the dialog commands. Paths and the action each accepts
 * mirror the vendor dispatch map in `lib/vendors/tesla/control.ts`.
 */
export interface TeslaChargeControlTargets {
  /** `ev.charge/active` — switch: turn_on → charge_start, turn_off → charge_stop. */
  active: string | null;
  /** `ev.charge.limit/soc` — number 50–100: set_value → set_charge_limit. */
  limitSoc: string | null;
  /** `ev.charge.limit/current` — number 0–48: set_value → set_charging_amps. */
  limitAmps: string | null;
}

/**
 * Any target may be null: `ev.charge/active` is a new point and has no KV entry until the device's
 * first poll on the new code. A null target disables its button rather than posting a guess.
 */
/**
 * The same three paths as a plain list, most-specific-first: the switch the cog's Start/Stop
 * commands, then the two setpoints. `datumCanControlPoint` uses it to identify WHICH DEVICE the
 * tile's controls would command — which is not necessarily the subject the tile fetched under.
 */
export const TESLA_CHARGE_CONTROL_PATHS = [
  "ev.charge/active",
  "ev.charge.limit/soc",
  "ev.charge.limit/current",
] as const;

export function teslaChargeControlTargets(
  latest: Record<string, LatestEntryLike> | null | undefined,
): TeslaChargeControlTargets {
  return {
    active: pointIdOf(latest, "ev.charge/active"),
    limitSoc: pointIdOf(latest, "ev.charge.limit/soc"),
    limitAmps: pointIdOf(latest, "ev.charge.limit/current"),
  };
}
