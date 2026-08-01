import { describe, it, expect } from "@jest/globals";
import {
  getEvStatus,
  getEvStatusWords,
  type EvStatus,
} from "@/lib/vendors/tesla/status";

/**
 * Every case below is a real (charging_state, charge_port_latch, shift_state)
 * combination observed in 30 days of raw Tesla payloads on device rid 10 —
 * including the ones that make the naive readings wrong: the latch reports
 * "Blocking" (→ pluggedIn false) rather than "Disengaged" when unplugged, and
 * the car has been seen in D and R while Disconnected.
 */
describe("getEvStatus", () => {
  const cases: Array<[string, Parameters<typeof getEvStatus>[0], EvStatus]> = [
    [
      "Complete + Engaged + P — plugged in, done charging",
      { chargingState: "Complete", pluggedIn: true, shift: "P" },
      "idle",
    ],
    [
      "Disconnected + Blocking + P — parked, no cable",
      { chargingState: "Disconnected", pluggedIn: false, shift: "P" },
      "unplugged",
    ],
    [
      "Charging + Engaged + P",
      { chargingState: "Charging", pluggedIn: true, shift: "P" },
      "charging",
    ],
    [
      "Starting + Engaged + P — treated as charging",
      { chargingState: "Starting", pluggedIn: true, shift: "P" },
      "charging",
    ],
    [
      "Disconnected + Blocking + D — driving beats unplugged",
      { chargingState: "Disconnected", pluggedIn: false, shift: "D" },
      "driving",
    ],
    [
      "Disconnected + Blocking + R — reverse is driving too",
      { chargingState: "Disconnected", pluggedIn: false, shift: "R" },
      "driving",
    ],
    [
      "Complete + Engaged + no shift reading",
      { chargingState: "Complete", pluggedIn: true, shift: null },
      "idle",
    ],
    [
      "Disconnected + Blocking + no shift reading",
      { chargingState: "Disconnected", pluggedIn: false, shift: null },
      "unplugged",
    ],
    [
      "asleep — nothing reported at all",
      { chargingState: null, pluggedIn: null, shift: null },
      "idle",
    ],
    [
      "unplugged inferred from the latch alone",
      { chargingState: "Stopped", pluggedIn: false, shift: "P" },
      "unplugged",
    ],
    [
      "Stopped + Engaged — plugged in but paused",
      { chargingState: "Stopped", pluggedIn: true, shift: "P" },
      "idle",
    ],
    [
      "NoPower + Engaged — plugged into a dead outlet",
      { chargingState: "NoPower", pluggedIn: true, shift: "P" },
      "idle",
    ],
    [
      "Charging + D — driving outranks charging",
      { chargingState: "Charging", pluggedIn: true, shift: "D" },
      "driving",
    ],
  ];

  it.each(cases)("%s", (_label, inputs, expected) => {
    expect(getEvStatus(inputs)).toBe(expected);
  });
});

describe("getEvStatusWords", () => {
  it("gives one word per rendered line", () => {
    expect(getEvStatusWords("driving")).toEqual(["Driving"]);
    expect(getEvStatusWords("charging")).toEqual(["Charging"]);
    expect(getEvStatusWords("idle")).toEqual(["Connected"]);
    expect(getEvStatusWords("unplugged")).toEqual(["Not", "Connected"]);
  });
});
