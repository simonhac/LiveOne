/**
 * The pure half of the command plane: what a writable point will accept, and whether two
 * control descriptors are the same.
 *
 * Deliberately dependency-free apart from the `PointControl` TYPE (whose home is
 * `lib/db/planetscale/schema.ts` — never re-homed here), so both the ingest path
 * (`PointManager.ensurePointInfo`'s drift heal) and the serving path (the action route)
 * can import it without dragging in the DB, the vendor registry or `next/server`.
 */
import type { PointControl } from "@/lib/db/planetscale/schema";

/** The closed action vocabulary. Mirrors HA's switch/number/button platforms. */
export const POINT_ACTION_NAMES = [
  "turn_on",
  "turn_off",
  "set_value",
  "press",
] as const;
export type PointActionName = (typeof POINT_ACTION_NAMES)[number];

export function isPointActionName(v: unknown): v is PointActionName {
  return (
    typeof v === "string" &&
    (POINT_ACTION_NAMES as readonly string[]).includes(v)
  );
}

export type PointActionValidation = { ok: true } | { ok: false; error: string };

/**
 * Validate an action + value against a point's control descriptor.
 *
 * - `control` null/undefined → the point is a read-only sensor.
 * - `switch` → `turn_on` | `turn_off`, no value.
 * - `number` → `set_value` with a finite number in `[min, max]`. `step` is a UI hint and is
 *   deliberately NOT enforced: `TeslaClient.setChargeLimit`/`setChargingAmps` round anyway
 *   (tesla-client.ts), so enforcing it here would only reject requests the vendor accepts.
 * - `button` → `press`, no value.
 */
export function validatePointAction(
  control: PointControl | null | undefined,
  action: string,
  value: unknown,
): PointActionValidation {
  if (!control) {
    return { ok: false, error: "Point is not controllable" };
  }
  if (!isPointActionName(action)) {
    return {
      ok: false,
      error: `Invalid action. Expected one of: ${POINT_ACTION_NAMES.join(", ")}`,
    };
  }

  const hasValue = value !== undefined && value !== null;

  if (action !== "set_value" && hasValue) {
    return { ok: false, error: `Action '${action}' does not take a value` };
  }

  switch (control.kind) {
    case "switch":
      if (action !== "turn_on" && action !== "turn_off") {
        return {
          ok: false,
          error: `Action '${action}' is not valid for a switch (expected turn_on or turn_off)`,
        };
      }
      return { ok: true };

    case "button":
      if (action !== "press") {
        return {
          ok: false,
          error: `Action '${action}' is not valid for a button (expected press)`,
        };
      }
      return { ok: true };

    case "number": {
      if (action !== "set_value") {
        return {
          ok: false,
          error: `Action '${action}' is not valid for a number (expected set_value)`,
        };
      }
      if (typeof value !== "number" || !Number.isFinite(value)) {
        return { ok: false, error: "set_value requires a numeric value" };
      }
      if (value < control.min || value > control.max) {
        return {
          ok: false,
          error: `Value ${value} is out of range (${control.min}–${control.max})`,
        };
      }
      return { ok: true };
    }

    default:
      // Exhaustive over the closed union; a future kind lands here until it is handled.
      return { ok: false, error: "Unsupported control kind" };
  }
}

/**
 * Field-wise equality over the closed `PointControl` union.
 *
 * 🛑 NEVER `JSON.stringify` these. `control` round-trips through a jsonb column and Postgres
 * does not preserve object key order, so a serialized comparison would report drift on every
 * poll and turn the mint heal (`PointManager.ensurePointInfo`) into a perpetual upsert storm
 * that churns `updated_at` on every controllable point.
 */
export function pointControlEquals(
  a: PointControl | null | undefined,
  b: PointControl | null | undefined,
): boolean {
  const x = a ?? null;
  const y = b ?? null;
  if (x === null || y === null) return x === y;
  if (x.kind !== y.kind) return false;
  if (x.kind === "number" && y.kind === "number") {
    return x.min === y.min && x.max === y.max && (x.step ?? undefined) === (y.step ?? undefined);
  }
  // switch / button carry no further fields.
  return true;
}
