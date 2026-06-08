import { describe, it, expect, jest, beforeEach } from "@jest/globals";

// Control READINGS_READS_FROM_PG per-test via a getter mock — readings-serve reads it as a module
// property on every call, so no module reloading is needed (mirrors config-shadow.test.ts).
let mockFlagOn = false;
jest.mock("../routing", () => ({
  get READINGS_READS_FROM_PG() {
    return mockFlagOn;
  },
}));

import {
  serveReadings,
  near,
  pairMatches,
  SHADOW_SKIP,
} from "../readings-serve";

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

describe("pairMatches (per-pair tolerance rule)", () => {
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

describe("serveReadings", () => {
  it("flag OFF: serves the Turso value and NEVER calls pgServe", async () => {
    const pgServe = jest.fn(async () => ({ x: 2 }));
    const out = await serveReadings("t", pgServe, async () => ({ x: 1 }));
    expect(out).toEqual({ x: 1 });
    expect(pgServe).not.toHaveBeenCalled();
  });

  it("flag ON + PG ok: serves the PG value and does NOT call tursoServe", async () => {
    mockFlagOn = true;
    const warn = jest.spyOn(console, "warn").mockImplementation(() => {});
    const tursoServe = jest.fn(async () => ({ x: 1 }));
    const out = await serveReadings("t", async () => ({ x: 2 }), tursoServe);
    expect(out).toEqual({ x: 2 }); // served from PG
    expect(tursoServe).not.toHaveBeenCalled();
    expect(warn).not.toHaveBeenCalled();
    warn.mockRestore();
  });

  it("flag ON + pgServe throws: falls back to Turso and warns once", async () => {
    mockFlagOn = true;
    const warn = jest.spyOn(console, "warn").mockImplementation(() => {});
    const out = await serveReadings(
      "t",
      async () => {
        throw new Error("pg down");
      },
      async () => ({ x: 1 }),
    );
    expect(out).toEqual({ x: 1 }); // Turso fallback
    expect(warn).toHaveBeenCalledTimes(1);
    expect(String(warn.mock.calls[0][0])).toContain("[READINGS-SERVE]");
    expect(String(warn.mock.calls[0][0])).toContain("pg unavailable");
    warn.mockRestore();
  });

  it("flag ON + pgServe returns SHADOW_SKIP: falls back to Turso and warns once", async () => {
    mockFlagOn = true;
    const warn = jest.spyOn(console, "warn").mockImplementation(() => {});
    const out = await serveReadings(
      "t",
      async () => SHADOW_SKIP,
      async () => ({ x: 1 }),
    );
    expect(out).toEqual({ x: 1 }); // Turso fallback
    expect(warn).toHaveBeenCalledTimes(1);
    expect(String(warn.mock.calls[0][0])).toContain("[READINGS-SERVE]");
    expect(String(warn.mock.calls[0][0])).toContain("pg unconfigured");
    warn.mockRestore();
  });

  it("flag ON + PG ok: tursoServe is not even invoked (no concurrent double-read)", async () => {
    mockFlagOn = true;
    let tursoStarted = false;
    const out = await serveReadings(
      "t",
      async () => ({ x: 2 }),
      async () => {
        tursoStarted = true;
        return { x: 1 };
      },
    );
    expect(out).toEqual({ x: 2 });
    expect(tursoStarted).toBe(false);
  });

  it("flag ON + PG throws + Turso fallback throws: propagates the Turso error", async () => {
    mockFlagOn = true;
    const warn = jest.spyOn(console, "warn").mockImplementation(() => {});
    await expect(
      serveReadings(
        "t",
        async () => {
          throw new Error("pg down");
        },
        async () => {
          throw new Error("turso down");
        },
      ),
    ).rejects.toThrow("turso down");
    warn.mockRestore();
  });
});
