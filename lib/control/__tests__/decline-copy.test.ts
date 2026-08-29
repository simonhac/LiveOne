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

  describe("the generator address", () => {
    const GEN = "source.generator.control.request/duration";

    it("🛑 passes the hub's sentence through UNCHANGED", () => {
      // The usher hub writes its refusals to be read by a human. Rewriting one into house copy
      // could only lose information — and the information is why a diesel engine did not start.
      const reason =
        "engine is already running, commanded by the SP-PRO (remote-start input closed).";
      expect(describeDecline("set_value", reason, GEN)).toEqual({
        text: reason,
        known: true,
      });
    });

    it("does NOT reinterpret a reason that happens to collide with Tesla's vocabulary", () => {
      expect(describeDecline("set_value", "not_charging", GEN)).toEqual({
        text: "not_charging",
        known: true,
      });
    });

    it("has its own calm fallback when the hub said nothing", () => {
      expect(describeDecline("set_value", null, GEN)).toEqual({
        text: "The generator hub declined the request.",
        known: false,
      });
    });

    it("leaves the Tesla vocabulary alone when no address is given", () => {
      expect(describeDecline("turn_off", "not_charging").text).toBe(
        "Charging was already stopped.",
      );
    });
  });
});
