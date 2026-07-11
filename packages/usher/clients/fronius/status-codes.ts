/**
 * Fronius inverter status codes and their meanings
 */

export interface FroniusStatusCode {
  code: number;
  name: string;
  description: string;
  isFault: boolean;
}

export const FRONIUS_STATUS_CODES: Record<number, FroniusStatusCode> = {
  0: {
    code: 0,
    name: "STARTUP_SELF_TEST",
    description: "Startup (self-test)",
    isFault: true,
  },
  1: {
    code: 1,
    name: "STARTUP_INITIALISING",
    description: "Startup (initialising)",
    isFault: true,
  },
  2: {
    code: 2,
    name: "STARTUP_MEASURING_GRID",
    description: "Startup (measuring grid)",
    isFault: true,
  },
  3: {
    code: 3,
    name: "STARTUP_WAITING_FOR_PV",
    description: "Startup (waiting for PV voltage)",
    isFault: true,
  },
  4: {
    code: 4,
    name: "STARTUP_CHECKING_GRID",
    description: "Startup (checking grid)",
    isFault: true,
  },
  5: {
    code: 5,
    name: "RUNNING_FEEDING_IN",
    description: "Running (power available, inverter feeding in)",
    isFault: false,
  },
  6: {
    code: 6,
    name: "RUNNING_MPP_TRACKING",
    description: "Running (MPP tracking)",
    isFault: false,
  },
  7: {
    code: 7,
    name: "STANDBY_NO_IRRADIATION",
    description: "Standby (no irradiation / PV voltage too low)",
    isFault: false,
  },
  8: {
    code: 8,
    name: "BOOTLOADING",
    description: "Bootloading (firmware update mode)",
    isFault: true,
  },
  9: {
    code: 9,
    name: "ERROR",
    description: "Error",
    isFault: true,
  },
  10: {
    code: 10,
    name: "OFFLINE_SHUTDOWN",
    description: "Offline / shutdown",
    isFault: true,
  },
  11: {
    code: 11,
    name: "IDLE_NO_GRID",
    description: "Idle (PV available but grid not present/valid)",
    isFault: false,
  },
  12: {
    code: 12,
    name: "WAITING_GRID_CONDITIONS",
    description: "Waiting (grid conditions not yet suitable)",
    isFault: true,
  },
  13: {
    code: 13,
    name: "RUNNING_DERATED",
    description:
      "Running: derated / limited (inverter is producing but not at full capacity — could be due to temperature, grid export limit, or other curtailment)",
    isFault: false,
  },
};

/**
 * Get status code information by code number
 */
export function getStatusCode(code: number): FroniusStatusCode | undefined {
  return FRONIUS_STATUS_CODES[code];
}

/**
 * Check if a status code represents a fault state
 */
export function isFaultStatus(code: number): boolean {
  const status = FRONIUS_STATUS_CODES[code];
  return status ? status.isFault : true; // Unknown codes are treated as faults
}

/**
 * Get a human-readable description for a status code
 */
export function getStatusDescription(code: number): string {
  const status = FRONIUS_STATUS_CODES[code];
  return status ? status.description : `Unknown status code: ${code}`;
}
