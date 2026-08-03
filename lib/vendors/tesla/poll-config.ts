/**
 * Tesla polling defaults + Fleet API cost model.
 *
 * Shared by the server adapter (lib/vendors/tesla/adapter.ts) and the client settings
 * card (components/TeslaConfigTab.tsx) so the defaults exist in exactly one place.
 * Keep this file import-free: it is bundled into the client.
 */

/** Per-device polling settings as edited/stored (devices.adapter_state.tesla), all fields present. */
export interface TeslaPollConfig {
  wakeToPoll: boolean;
  idlePollMinutes: number;
  chargingPollMinutes: number;
}

/**
 * Adapter fallbacks AND the settings-form seed. chargingPollMinutes dropped 5 → 2 (2026-08-03):
 * 2-min resolution bounds a charge-limit overshoot to ~2 min / ~0.23 kWh at 7 kW, and with the
 * skip-getVehicles-while-charging optimisation costs ~$10.20/mo on the reference config — about
 * the $10/mo Fleet credit.
 */
export const TESLA_POLL_DEFAULTS: TeslaPollConfig = {
  wakeToPoll: true, // legacy behaviour: wake a sleeping car on every poll
  idlePollMinutes: 15,
  chargingPollMinutes: 2,
};

// --- Fleet API cost model (rough, for the live estimate on the settings card) ---
// Tesla pay-per-use rates and the per-account monthly credit.
export const DATA_REQUEST_COST = 0.002; // getVehicles and getVehicleData each cost this
export const WAKE_COST = 0.02; // wake_up command
export const MONTHLY_CREDIT = 10;
export const DAYS_PER_MONTH = 30;
// Assumption baked into the estimate: 2 h/day charging (car online), 22 h/day idle. We further
// assume the car is asleep when idle (the costly case), so the wake toggle matters.
export const CHARGING_HOURS = 2;
export const IDLE_HOURS = 24 - CHARGING_HOURS;

export interface PollEstimate {
  pollsPerDay: number;
  monthlyCost: number;
  monthlyAfterCredit: number;
}

export function estimatePolls(config: TeslaPollConfig): PollEstimate {
  const idlePolls = (IDLE_HOURS * 60) / config.idlePollMinutes;
  const chargingPolls = (CHARGING_HOURS * 60) / config.chargingPollMinutes;
  const pollsPerDay = idlePolls + chargingPolls;

  // Charging: the previous poll reported charging, so the adapter skips the getVehicles
  // sleep-state check — one getVehicleData per poll. (The first poll of a session and any
  // post-cold-start poll still pay the check; ignored as noise in a rough estimate.)
  const chargingCost = chargingPolls * DATA_REQUEST_COST;
  // Idle (assume asleep): wake-to-poll adds a wake + the vehicle_data read; otherwise we
  // only spend the getVehicles call that checks the sleep state.
  const idleCost = config.wakeToPoll
    ? idlePolls * (2 * DATA_REQUEST_COST + WAKE_COST)
    : idlePolls * DATA_REQUEST_COST;

  const monthlyCost = (chargingCost + idleCost) * DAYS_PER_MONTH;
  return {
    pollsPerDay,
    monthlyCost,
    monthlyAfterCredit: Math.max(0, monthlyCost - MONTHLY_CREDIT),
  };
}
