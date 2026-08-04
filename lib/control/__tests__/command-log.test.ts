import { describe, expect, it } from "@jest/globals";
import { formatCommandEntry, type CommandLogEntryJson } from "../command-log";

const NOW = Date.parse("2026-08-04T11:10:00.000Z");
const AT = "2026-08-04T11:08:00.000Z"; // 2 min before NOW

function entry(over: Partial<CommandLogEntryJson>): CommandLogEntryJson {
  return {
    pointId: "pt_x",
    logicalPath: "ev.charge",
    metricType: "active",
    action: "turn_on",
    value: null,
    status: "ok",
    reason: null,
    error: null,
    requestedBy: { kind: "user" },
    requestedAt: AT,
    completedAt: AT,
    ...over,
  };
}

describe("formatCommandEntry", () => {
  it("carries requestedAt through as timeMs", () => {
    expect(formatCommandEntry(entry({}), NOW).timeMs).toBe(Date.parse(AT));
  });

  describe("clean successes", () => {
    it.each([
      [entry({}), "You started charging"],
      [entry({ action: "turn_off" }), "You stopped charging"],
      [
        entry({
          logicalPath: "ev.charge.limit",
          metricType: "soc",
          action: "set_value",
          value: 80,
        }),
        "You set the charge limit to 80%",
      ],
      [
        entry({
          logicalPath: "ev.charge.limit",
          metricType: "current",
          action: "set_value",
          value: 16,
        }),
        "You set charging to 16 A",
      ],
    ])("case %#", (e, sentence) => {
      expect(formatCommandEntry(e, NOW)).toMatchObject({
        sentence,
        tone: "ok",
      });
    });
  });

  describe("who", () => {
    it("names the automation that fired", () => {
      expect(
        formatCommandEntry(
          entry({
            action: "turn_off",
            requestedBy: {
              kind: "automation",
              automationId: "au_x",
              name: "Stop after 15 min",
            },
          }),
          NOW,
        ).sentence,
      ).toBe("‘Stop after 15 min’ stopped charging");
    });

    it("stays honest when the rule has been deleted", () => {
      expect(
        formatCommandEntry(
          entry({
            action: "turn_off",
            requestedBy: {
              kind: "automation",
              automationId: "au_x",
              name: null,
            },
          }),
          NOW,
        ).sentence,
      ).toBe("An automation stopped charging");
    });
  });

  describe("benign declines read as reassurance, not failure", () => {
    it("start while already charging", () => {
      expect(
        formatCommandEntry(
          entry({ status: "rejected", reason: "is_charging" }),
          NOW,
        ),
      ).toMatchObject({
        sentence:
          "You asked to start charging, but the car says it’s already charging",
        tone: "benign",
      });
    });

    it("stop while already stopped", () => {
      expect(
        formatCommandEntry(
          entry({
            status: "rejected",
            action: "turn_off",
            reason: "not_charging",
          }),
          NOW,
        ),
      ).toMatchObject({
        sentence:
          "You asked to stop charging, but charging was already stopped",
        tone: "benign",
      });
    });
  });

  describe("real failures", () => {
    it("an unknown rejection reason is an error, with the detail shown", () => {
      expect(
        formatCommandEntry(
          entry({
            status: "rejected",
            reason: null,
            error:
              "This vehicle requires signed commands (Tesla Vehicle Command protocol), which isn't supported yet.",
          }),
          NOW,
        ),
      ).toMatchObject({
        sentence:
          "You asked to start charging, but the car refused (This vehicle requires signed commands (Tesla Vehicle Command protocol), which isn't supported yet.)",
        tone: "error",
      });
    });

    it("a failed dispatch", () => {
      expect(
        formatCommandEntry(entry({ status: "failed" }), NOW),
      ).toMatchObject({
        sentence:
          "You asked to start charging, but the car couldn’t be reached",
        tone: "error",
      });
    });
  });

  describe("pending", () => {
    it("a fresh pending row is an ellipsis", () => {
      expect(
        formatCommandEntry(
          entry({
            status: "pending",
            requestedAt: new Date(NOW - 30_000).toISOString(),
          }),
          NOW,
        ),
      ).toMatchObject({
        sentence: "You asked to start charging…",
        tone: "pending",
      });
    });

    it("a stale pending row says so", () => {
      expect(
        formatCommandEntry(
          entry({
            status: "pending",
            requestedAt: new Date(NOW - 5 * 60_000).toISOString(),
          }),
          NOW,
        ),
      ).toMatchObject({
        sentence: "You asked to start charging (still waiting)",
        tone: "pending",
      });
    });
  });

  it("an unknown point address degrades to an honest generic", () => {
    expect(
      formatCommandEntry(
        entry({ logicalPath: "hws", metricType: "active", action: "press" }),
        NOW,
      ).sentence,
    ).toBe("You sent 'press' to hws/active");
  });
});
