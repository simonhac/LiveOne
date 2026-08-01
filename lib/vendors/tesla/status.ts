/**
 * The four states a Tesla can be in, as far as the dashboard cares.
 *
 * Tesla reports six `charging_state` values, a charge-port latch and a shift
 * state; none of them alone answers "what is the car doing". This folds them
 * into the four the tile shows.
 */
export type EvStatus = "driving" | "charging" | "idle" | "unplugged";

export interface EvStatusInputs {
  /** `ev/shift` — P/R/N/D. Absent until the first poll after this point shipped. */
  shift: string | null;
  /** `ev.charge/state` — Disconnected | NoPower | Starting | Charging | Stopped | Complete */
  chargingState: string | null;
  /** `ev.charge/engaged` — the charge-port latch. Arrives from KV as 1/0, not a boolean. */
  pluggedIn: boolean | null;
}

const DRIVING_SHIFTS = new Set(["D", "R", "N"]);
const CHARGING_STATES = new Set(["Charging", "Starting"]);

/**
 * Precedence matters: a car in D is "driving" even while the latch still reads
 * engaged, and `Disconnected` beats the latch because the latch reports
 * "Blocking" (not "Disengaged") when there is no cable.
 */
export function getEvStatus({
  shift,
  chargingState,
  pluggedIn,
}: EvStatusInputs): EvStatus {
  if (shift !== null && DRIVING_SHIFTS.has(shift)) return "driving";
  if (chargingState !== null && CHARGING_STATES.has(chargingState))
    return "charging";
  if (chargingState === "Disconnected" || pluggedIn === false)
    return "unplugged";
  return "idle";
}

/**
 * The status words, one per rendered line — the tile stacks these right-aligned
 * so the donut keeps the vertical space.
 */
export function getEvStatusWords(status: EvStatus): string[] {
  switch (status) {
    case "driving":
      return ["Driving"];
    case "charging":
      return ["Charging"];
    case "idle":
      return ["Connected"];
    case "unplugged":
      return ["Not", "Connected"];
  }
}
