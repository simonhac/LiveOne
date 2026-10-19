import { describe, expect, it } from "@jest/globals";
import type { Advice } from "../advisor";
import { clockTime, renderAdvice } from "../message";
import { MockTextSender } from "../notify";
import { aest, TZ } from "./fixtures";

const D = "2026-07-01";
const advice = (over: Partial<Advice>): Advice => ({
  atMs: aest(D, 21),
  night: D,
  socPct: 58.2,
  evW: 7000,
  sessionStartMs: aest(D, 20, 30),
  sessionKwhSoFar: 3.5,
  profileNights: [],
  solution: { kind: "no-action", coverAtMs: aest("2026-07-02", 7, 15) },
  ...over,
});

describe("clockTime", () => {
  it("renders a compact local 12-hour time", () => {
    expect(clockTime(aest(D, 22, 35), TZ)).toBe("10:35pm");
    expect(clockTime(aest(D, 0, 5), TZ)).toBe("12:05am");
  });
});

describe("renderAdvice", () => {
  it("stop-at: time, SoC alternative and the car's total", () => {
    const m = renderAdvice(
      advice({
        solution: {
          kind: "stop-at",
          stopAtMs: aest(D, 22, 35),
          stopSocPct: 31.4,
          evKwhFromNow: 19.6,
          needKwh: 6,
          coverAtMs: aest("2026-07-02", 7, 15),
        },
      }),
      TZ,
    );
    expect(m.send).toBe(true);
    expect(m.body).toBe(
      "I notice the car is charging from your home battery. It's at 58%. " +
        "If you turn off car charging at 10:35pm — or when the home battery gets to 31% — the car " +
        "will have had 23 kWh and you'll still have enough in the battery to carry the house " +
        "through to the morning sun.",
    );
  });

  it("stop-at within ten minutes is phrased as now", () => {
    const m = renderAdvice(
      advice({
        solution: {
          kind: "stop-at",
          stopAtMs: aest(D, 21, 5),
          stopSocPct: 55,
          evKwhFromNow: 0.6,
          needKwh: 6,
          coverAtMs: aest("2026-07-02", 7),
        },
      }),
      TZ,
    );
    expect(m.body).toContain("in the next few minutes (by 9:05pm)");
  });

  it("stop-now names the expected grid import, or 'just enough' when it rounds to nothing", () => {
    const sol = {
      kind: "stop-now" as const,
      shortfallKwh: 1.24,
      needKwh: 7,
      requiredSocPct: 34,
      coverAtMs: aest("2026-07-02", 7),
    };
    const short = renderAdvice(advice({ socPct: 30, solution: sol }), TZ);
    expect(short.send).toBe(true);
    expect(short.body).toContain("already below the 34%");
    expect(short.body).toContain("about 1.2 kWh from the grid");
    const enough = renderAdvice(
      advice({ socPct: 30, solution: { ...sol, shortfallKwh: 0.1 } }),
      TZ,
    );
    expect(enough.body).toContain("there's just enough left");
  });

  it("does not send no-action or battery-empty", () => {
    expect(renderAdvice(advice({}), TZ).send).toBe(false);
    expect(
      renderAdvice(
        advice({
          socPct: 10,
          solution: { kind: "battery-empty", needKwh: 6, coverAtMs: 0 },
        }),
        TZ,
      ).send,
    ).toBe(false);
  });
});

describe("MockTextSender", () => {
  it("records each message and writes it to the sink", async () => {
    const lines: string[] = [];
    const sender = new MockTextSender(
      (l) => lines.push(l),
      () => 42,
    );
    const { id } = await sender.send({ to: "+61400000000", body: "hi" });
    expect(id).toBe("mock-1");
    expect(sender.sent).toEqual([
      { to: "+61400000000", body: "hi", id: "mock-1", sentAtMs: 42 },
    ]);
    expect(JSON.parse(lines[0]).body).toBe("hi");
  });
});
