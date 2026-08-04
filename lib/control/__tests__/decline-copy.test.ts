import { describe, expect, it } from "@jest/globals";
import { describeDecline } from "../decline-copy";

describe("describeDecline", () => {
  it.each([
    ["turn_on", "is_charging", "The car says it’s already charging."],
    ["turn_on", "charging", "The car says it’s already charging."],
    ["turn_off", "is_charging", "The car is still charging."],
    ["turn_off", "not_charging", "Charging was already stopped."],
    ["turn_on", "complete", "The charge is already complete."],
    ["set_value", "already_set", "That was already set."],
    ["turn_on", "disconnected", "The car isn’t plugged in."],
  ] as const)("%s + %s → %s", (action, reason, text) => {
    expect(describeDecline(action, reason)).toEqual({ text, known: true });
  });

  it("is case-insensitive on the reason", () => {
    expect(describeDecline("turn_off", "Not_Charging")).toEqual({
      text: "Charging was already stopped.",
      known: true,
    });
  });

  it("falls back calmly on an unknown reason, keeping the raw token visible", () => {
    expect(describeDecline("turn_on", "requested")).toEqual({
      text: "The car didn’t need to do that (reason: requested).",
      known: false,
    });
  });

  it("falls back calmly on a missing reason", () => {
    expect(describeDecline("press", null)).toEqual({
      text: "The car didn’t need to do that.",
      known: false,
    });
  });
});
