import { describe, it, expect, jest, beforeEach } from "@jest/globals";

// Control READINGS_READS_FROM_PG per-test via a getter mock — readings-shadow reads it as a module
// property on every call, so no module reloading is needed (mirrors config-shadow.test.ts).
let mockFlagOn = false;
jest.mock("../routing", () => ({
  get READINGS_READS_FROM_PG() {
    return mockFlagOn;
  },
}));

import {
  shadowServeReadings,
  near,
  pairMatches,
  SHADOW_SKIP,
} from "../readings-shadow";

beforeEach(() => {
  mockFlagOn = false;
});

describe("near", () => {
  it("treats values within relative tolerance (floor 1) as equal", () => {
    expect(near(1.0, 1.0 + 1e-9)).toBe(true);
    expect(near(0, 1e-9)).toBe(true); // floor of 1 gives small magnitudes absolute slack
    expect(near(1000, 1000.0001)).toBe(true);
  });
  it("rejects values outside tolerance", () => {
    expect(near(1, 2)).toBe(false);
    expect(near(1000, 1001)).toBe(false);
  });
});

describe("pairMatches (shadow per-pair rule)", () => {
  it("null/undefined on either side is never a divergence (presence-only / live-tail lag)", () => {
    expect(pairMatches(null, 5)).toBe(true);
    expect(pairMatches(5, null)).toBe(true);
    expect(pairMatches(null, null)).toBe(true);
    expect(pairMatches(undefined, 5)).toBe(true);
  });
  it("compares two numbers within tolerance, exact otherwise", () => {
    expect(pairMatches(1.0, 1.0 + 1e-9)).toBe(true);
    expect(pairMatches(1, 2)).toBe(false);
    expect(pairMatches("good", "good")).toBe(true);
    expect(pairMatches("good", "forecast")).toBe(false);
  });
});

describe("shadowServeReadings", () => {
  const matchAll = () => ({ matched: true as const });

  it("flag OFF: returns the Turso value and NEVER calls pgServe", async () => {
    const pgServe = jest.fn(async () => ({ x: 2 }));
    const out = await shadowServeReadings("t", async () => ({ x: 1 }), {
      pgServe,
      compare: matchAll,
    });
    expect(out).toEqual({ x: 1 });
    expect(pgServe).not.toHaveBeenCalled();
  });

  it("flag ON + match: returns the Turso value, no warn", async () => {
    mockFlagOn = true;
    const warn = jest.spyOn(console, "warn").mockImplementation(() => {});
    const out = await shadowServeReadings("t", async () => ({ x: 1 }), {
      pgServe: async () => ({ x: 1 }),
      compare: () => ({ matched: true }),
      sampleRate: 1,
    });
    expect(out).toEqual({ x: 1 });
    expect(warn).not.toHaveBeenCalled();
    warn.mockRestore();
  });

  it("flag ON + diverge: STILL returns the Turso value, and warns once", async () => {
    mockFlagOn = true;
    const warn = jest.spyOn(console, "warn").mockImplementation(() => {});
    const out = await shadowServeReadings("t", async () => ({ x: 1 }), {
      pgServe: async () => ({ x: 2 }),
      compare: () => ({ matched: false, detail: "x: turso=1 pg=2" }),
      sampleRate: 1,
    });
    expect(out).toEqual({ x: 1 }); // served value unchanged by the shadow
    expect(warn).toHaveBeenCalledTimes(1);
    expect(String(warn.mock.calls[0][0])).toContain("[READINGS-SHADOW]");
    expect(String(warn.mock.calls[0][0])).toContain("DIVERGE");
    warn.mockRestore();
  });

  it("flag ON + pgServe throws: returns the Turso value, error swallowed (no throw)", async () => {
    mockFlagOn = true;
    const warn = jest.spyOn(console, "warn").mockImplementation(() => {});
    const compare = jest.fn(matchAll);
    const out = await shadowServeReadings("t", async () => ({ x: 1 }), {
      pgServe: async () => {
        throw new Error("pg down");
      },
      compare,
      sampleRate: 1,
    });
    expect(out).toEqual({ x: 1 });
    expect(compare).not.toHaveBeenCalled();
    expect(warn).toHaveBeenCalledTimes(1);
    warn.mockRestore();
  });

  it("flag ON + pgServe returns SHADOW_SKIP: returns Turso, compare not run, no warn", async () => {
    mockFlagOn = true;
    const warn = jest.spyOn(console, "warn").mockImplementation(() => {});
    const compare = jest.fn(matchAll);
    const out = await shadowServeReadings("t", async () => ({ x: 1 }), {
      pgServe: async () => SHADOW_SKIP,
      compare,
      sampleRate: 1,
    });
    expect(out).toEqual({ x: 1 });
    expect(compare).not.toHaveBeenCalled();
    expect(warn).not.toHaveBeenCalled();
    warn.mockRestore();
  });

  it("flag ON + tursoServe throws: propagates (Turso is the served path)", async () => {
    mockFlagOn = true;
    await expect(
      shadowServeReadings(
        "t",
        async () => {
          throw new Error("turso down");
        },
        {
          pgServe: async () => ({ x: 2 }),
          compare: matchAll,
          sampleRate: 1,
        },
      ),
    ).rejects.toThrow("turso down");
  });

  it("sampleRate 0: flag ON but request not sampled → pgServe never called", async () => {
    mockFlagOn = true;
    const pgServe = jest.fn(async () => ({ x: 2 }));
    const out = await shadowServeReadings("t", async () => ({ x: 1 }), {
      pgServe,
      compare: matchAll,
      sampleRate: 0,
    });
    expect(out).toEqual({ x: 1 });
    expect(pgServe).not.toHaveBeenCalled();
  });

  it("runs Turso and PG reads concurrently (both start before either resolves)", async () => {
    mockFlagOn = true;
    let tursoStarted = false;
    let pgStarted = false;
    let resolveTurso!: (v: { x: number }) => void;
    let resolvePg!: (v: { x: number }) => void;

    const promise = shadowServeReadings(
      "t",
      () => {
        tursoStarted = true;
        return new Promise<{ x: number }>((r) => (resolveTurso = r));
      },
      {
        pgServe: () => {
          pgStarted = true;
          return new Promise<{ x: number }>((r) => (resolvePg = r));
        },
        compare: () => ({ matched: true }),
        sampleRate: 1,
      },
    );

    // Let the synchronous body of shadowServeReadings run (it invokes both thunks before awaiting).
    await Promise.resolve();
    expect(tursoStarted).toBe(true);
    expect(pgStarted).toBe(true);

    resolveTurso({ x: 1 });
    resolvePg({ x: 1 });
    await expect(promise).resolves.toEqual({ x: 1 });
  });
});
