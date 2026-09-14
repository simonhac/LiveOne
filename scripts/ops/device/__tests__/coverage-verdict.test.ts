/**
 * What `device coverage` is allowed to CALL a result — and what it exits with.
 *
 * 🛑 The regression pinned here. With no vendor cadence declared, the expectation falls back to the
 * best day observed. If the device produced NOTHING in the window that fallback is 0, and 0
 * expected per day makes every empty day trivially complete: the verb printed "every day is
 * complete at 0/day" and exited 0 for a device that had been dark the entire time.
 *
 * That device is the motivating case for the whole verb — a push vendor (`fusher`) that no cron,
 * alert or other command reports. Answering it with a clean bill of health is worse than not having
 * the verb at all.
 */
import { describe, it, expect, jest } from "@jest/globals";
import { parse, type Tty } from "@/lib/cli/cli";

const TTY: Tty = { stdoutIsTTY: true, stdinIsTTY: true };

function wire(over: Record<string, unknown> = {}) {
  const days = ["2026-01-01", "2026-01-02"];
  return {
    device: {
      id: "dv_fronius",
      name: "Kinkora Fronius",
      handle: 6,
      vendor: "fusher",
      status: "active",
      dayOffsetMin: 600,
    },
    window: { start: days[0], end: days[1], days },
    cadenceMinutes: null,
    expectedPerDay: 0,
    expectedBasis: "none",
    count: 2,
    points: [
      {
        pointId: "pt_a",
        logicalPath: "bidi.battery",
        metricType: "soc",
        unit: "%",
        series: [],
        counts: [0, 0],
        total: 0,
        expectedTotal: 0,
        coveragePct: null,
        firstDay: null,
        lastDay: null,
        gaps: [],
      },
    ],
    ...over,
  };
}

async function run(body: unknown, argv: string[] = ["coverage", "kink_fron"]) {
  let human = "";
  jest.resetModules();
  jest.doMock("@/lib/cli-kit/api-session", () => ({
    withApiSession: async (
      _ctx: unknown,
      fn: (s: unknown) => Promise<number>,
    ) =>
      fn({
        origin: "https://example.test",
        token: "lo_cli_x",
        get: async (p: string) =>
          p === "/api/v4/devices"
            ? {
                devices: [
                  {
                    id: "dv_fronius",
                    legacySystemId: 6,
                    name: "Kinkora Fronius",
                    slug: "kink_fron",
                    vendor: "fusher",
                    status: "active",
                    ownerUserId: "u",
                    areaId: null,
                    areaName: null,
                  },
                ],
              }
            : body,
      }),
  }));
  const { runCoverage } = await import("../coverage");
  const { deviceCommand } = await import("../cli");
  const r = parse(deviceCommand, argv, TTY, ["liveone"]);
  if (!r.ok) throw new Error(JSON.stringify(r.error));
  const ctx = {
    ...r,
    format: "human",
    emit: (_m: unknown, h: () => string) => {
      human = h();
    },
    note: () => {},
    warn: () => {},
    confirm: async () => true,
  };
  const code = await runCoverage(ctx as never);
  return { code, human };
}

describe("a device that produced nothing, with no declared cadence", () => {
  it("never renders the completeness verdict", async () => {
    const { human } = await run(wire());
    // The verdict line specifically — the prose below it uses the word to say the opposite.
    expect(human).not.toMatch(/every day is complete/);
    expect(human).not.toMatch(/point\(s\) checked — every/);
    expect(human).toMatch(/NOT ONE holds a single row/);
  });

  it("names the expectation as UNKNOWN, not as 0/day", async () => {
    const { human } = await run(wire());
    expect(human).toMatch(/expected\s+UNKNOWN/);
    expect(human).not.toMatch(/expected\s+0\/day/);
  });

  it("points at --cadence, which is the way to get an answer", async () => {
    const { human } = await run(wire());
    expect(human).toMatch(/--cadence/);
  });

  it("exits 1, so a scripted check cannot read it as a pass", async () => {
    const { code } = await run(wire());
    expect(code).toBe(1);
  });

  it("still says 'complete' when an expectation really was established", async () => {
    const { code, human } = await run(
      wire({
        expectedPerDay: 288,
        expectedBasis: "vendor",
        cadenceMinutes: 5,
        points: [
          {
            ...wire().points[0],
            counts: [288, 288],
            total: 576,
            expectedTotal: 576,
            coveragePct: 100,
            firstDay: "2026-01-01",
            lastDay: "2026-01-02",
            gaps: [],
          },
        ],
      }),
    );
    expect(human).toMatch(/every day is complete at 288\/day/);
    expect(code).toBe(0);
  });
});

describe("no matching points", () => {
  it("is a finding, not an empty success", async () => {
    const { code, human } = await run(
      wire({
        count: 0,
        points: [],
        expectedBasis: "vendor",
        expectedPerDay: 288,
      }),
    );
    expect(human).toMatch(/no points matched/);
    expect(code).toBe(1);
  });
});
