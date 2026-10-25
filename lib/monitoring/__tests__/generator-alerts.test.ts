/**
 * Generator alerts: one page per episode, then a repeat at most once a day — never one every 15 min
 * for the days a flat battery takes to reach.
 */
import { describe, it, expect, jest, beforeEach } from "@jest/globals";
import type { GeneratorIssue } from "@/lib/control/generator-health";

const kvSet = jest.fn<(...a: unknown[]) => Promise<unknown>>();
jest.mock("@/lib/kv", () => ({
  kv: { set: (...a: unknown[]) => kvSet(...a) },
  kvKey: (p: string) => `test:${p}`,
}));
const sendAlert = jest.fn<(...a: unknown[]) => Promise<boolean>>();
jest.mock("@/lib/alerts", () => ({
  sendAlert: (...a: unknown[]) => sendAlert(...a),
}));
const listEnabled = jest.fn<() => Promise<unknown[]>>();
jest.mock("@/lib/automations/store", () => ({
  listEnabled: () => listEnabled(),
}));
jest.mock("@/lib/areas/http", () => ({
  loadAreaForAuth: async (id: string) => ({
    id,
    displayName: "Daylesford",
    legacySystemId: 1000002,
    status: "active",
    displayTimezone: "Australia/Melbourne",
  }),
}));
const issues: GeneratorIssue[] = [];
jest.mock("@/lib/control/generator-health-server", () => ({
  loadGeneratorHealth: async () => ({ hasGenerator: true, issues }),
}));

import {
  checkGeneratorAlerts,
  formatGeneratorAlert,
} from "../generator-alerts";

const FLAT: GeneratorIssue = {
  code: "battery_flat",
  severity: "critical",
  title: "Starter battery flat · 3.5 V",
  detail: "3.5 V — too low to crank the engine.",
  sinceMs: 1_792_000_000_000,
};
const ERROR: GeneratorIssue = {
  code: "control_error",
  severity: "warning",
  title: "Hub reported an error",
  detail: null,
  sinceMs: 1,
};

beforeEach(() => {
  kvSet.mockReset();
  sendAlert.mockReset().mockResolvedValue(true);
  listEnabled.mockReset().mockResolvedValue([
    { areaId: "area-1", trigger: { kind: "exercise" } },
    { areaId: "area-1", trigger: { kind: "exercise" } },
    { areaId: "area-2", trigger: { kind: "charge-session" } },
  ]);
  issues.splice(0, issues.length, FLAT, ERROR);
});

describe("checkGeneratorAlerts", () => {
  it("pages a new episode once, for each area with an exercise rule", async () => {
    kvSet.mockResolvedValue("OK");
    const s = await checkGeneratorAlerts();
    expect(s.areasChecked).toBe(1);
    expect(s.sent).toBe(1); // the battery; a hub error alone does not page
    expect(sendAlert.mock.calls[0][0]).toContain(
      "Generator at Daylesford: Starter battery flat",
    );
    // 🛑 NOT keyed on the battery's `sinceMs`: that is its latest reading, which moves every push,
    // and a key that changes every check is no throttle at all.
    expect(kvSet.mock.calls[0][0]).toBe(
      "test:alert:generator:area-1:battery_flat:ongoing",
    );
    expect(kvSet.mock.calls[0][2]).toEqual({ nx: true, ex: 24 * 3600 });
  });

  it("stays quiet while the episode's throttle key still exists", async () => {
    kvSet.mockResolvedValue(null);
    expect((await checkGeneratorAlerts()).sent).toBe(0);
    expect(sendAlert).not.toHaveBeenCalled();
  });

  it("fails OPEN when the throttle store is down — a repeat beats a silence", async () => {
    kvSet.mockRejectedValue(new Error("kv down"));
    expect((await checkGeneratorAlerts()).sent).toBe(1);
  });
});

describe("episode keys", () => {
  it("keys an exercise or outage on its onset, so the next one alerts at once", async () => {
    kvSet.mockResolvedValue("OK");
    issues.splice(0, issues.length, {
      code: "exercise_missed",
      severity: "critical",
      title: "Exercise missed · Thu 22 Oct",
      detail: null,
      sinceMs: 1_792_612_800_000,
    });
    await checkGeneratorAlerts();
    expect(kvSet.mock.calls[0][0]).toBe(
      "test:alert:generator:area-1:exercise_missed:1792612800000",
    );
  });
});

describe("formatGeneratorAlert", () => {
  it("leads with the area and the issue, evidence on the next line", () => {
    expect(formatGeneratorAlert("Daylesford", FLAT)).toBe(
      "🚨 Generator at Daylesford: Starter battery flat · 3.5 V\n3.5 V — too low to crank the engine.",
    );
  });
});
