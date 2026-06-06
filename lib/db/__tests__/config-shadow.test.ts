import { describe, it, expect, jest, beforeEach } from "@jest/globals";

// Control the CONFIG_READS_FROM_PG flag per-test via a getter mock. config-shadow accesses
// it as a module property (routing_1.CONFIG_READS_FROM_PG), so the getter is re-evaluated
// on every read — no module reloading needed.
let mockFlagOn = false;
jest.mock("../routing", () => ({
  get CONFIG_READS_FROM_PG() {
    return mockFlagOn;
  },
}));

import {
  shadowReadConfig,
  stableStringify,
  toEpochSeconds,
  normalizeJson,
  compareNormalized,
} from "../config-shadow";

beforeEach(() => {
  mockFlagOn = false;
});

describe("config-shadow normalizers", () => {
  it("toEpochSeconds truncates Date and ms-number to whole seconds; null→null", () => {
    expect(toEpochSeconds(new Date(1749081599611))).toBe(1749081599);
    expect(toEpochSeconds(1749081599611)).toBe(1749081599);
    // sub-second difference collapses to the same second...
    expect(toEpochSeconds(new Date(1749081599000))).toBe(
      toEpochSeconds(new Date(1749081599999)),
    );
    // ...but a ≥1s difference does not.
    expect(toEpochSeconds(new Date(1749081599000))).not.toBe(
      toEpochSeconds(new Date(1749081600000)),
    );
    expect(toEpochSeconds(null)).toBeNull();
    expect(toEpochSeconds(undefined)).toBeNull();
  });

  it("normalizeJson parses strings (Turso text-json) and passes objects through (PG jsonb)", () => {
    expect(normalizeJson('{"a":1}')).toEqual({ a: 1 });
    expect(normalizeJson({ a: 1 })).toEqual({ a: 1 });
    expect(normalizeJson(null)).toBeNull();
    expect(normalizeJson("not json")).toBe("not json");
  });

  it("stableStringify is key-order independent (incl. nested)", () => {
    expect(stableStringify({ a: 1, b: 2 })).toBe(
      stableStringify({ b: 2, a: 1 }),
    );
    expect(stableStringify({ a: { y: 1, x: 2 } })).toBe(
      stableStringify({ a: { x: 2, y: 1 } }),
    );
  });
});

describe("compareNormalized", () => {
  it("matches structurally-equal objects regardless of key order (no warn)", () => {
    const warn = jest.spyOn(console, "warn").mockImplementation(() => {});
    const r = compareNormalized("t", "1", { a: 1, b: 2 }, { b: 2, a: 1 });
    expect(r).toEqual({ matched: true, diffFields: [] });
    expect(warn).not.toHaveBeenCalled();
    warn.mockRestore();
  });

  it("reports exactly the divergent fields and warns once", () => {
    const warn = jest.spyOn(console, "warn").mockImplementation(() => {});
    const r = compareNormalized(
      "t",
      "1",
      { a: 1, b: 2, c: 3 },
      { a: 1, b: 9, c: 3 },
    );
    expect(r.matched).toBe(false);
    expect(r.diffFields).toEqual(["b"]);
    expect(warn).toHaveBeenCalledTimes(1);
    warn.mockRestore();
  });
});

describe("shadowReadConfig", () => {
  it("flag OFF: returns the Turso value and NEVER calls pgRead", async () => {
    const pgRead = jest.fn(async () => ({ x: 2 }));
    const out = await shadowReadConfig("t", async () => ({ x: 1 }), {
      pgRead,
      normalize: (v) => v,
    });
    expect(out).toEqual({ x: 1 });
    expect(pgRead).not.toHaveBeenCalled();
  });

  it("flag ON + match: returns the Turso value, no warn", async () => {
    mockFlagOn = true;
    const warn = jest.spyOn(console, "warn").mockImplementation(() => {});
    const out = await shadowReadConfig("t", async () => ({ x: 1 }), {
      pgRead: async () => ({ x: 1 }),
      normalize: (v) => v,
    });
    expect(out).toEqual({ x: 1 });
    expect(warn).not.toHaveBeenCalled();
    warn.mockRestore();
  });

  it("flag ON + diverge: STILL returns the Turso value, and warns", async () => {
    mockFlagOn = true;
    const warn = jest.spyOn(console, "warn").mockImplementation(() => {});
    const out = await shadowReadConfig("t", async () => ({ x: 1 }), {
      pgRead: async () => ({ x: 2 }),
      normalize: (v) => v,
    });
    expect(out).toEqual({ x: 1 }); // served value is unchanged by the shadow
    expect(warn).toHaveBeenCalledTimes(1);
    warn.mockRestore();
  });

  it("flag ON + pgRead throws: returns the Turso value, error swallowed (no throw)", async () => {
    mockFlagOn = true;
    const warn = jest.spyOn(console, "warn").mockImplementation(() => {});
    const out = await shadowReadConfig("t", async () => ({ x: 1 }), {
      pgRead: async () => {
        throw new Error("pg down");
      },
      normalize: (v) => v,
    });
    expect(out).toEqual({ x: 1 });
    expect(warn).toHaveBeenCalled();
    warn.mockRestore();
  });

  it("flag ON: normalizers neutralize sub-second timestamp + json-key-order divergence", async () => {
    mockFlagOn = true;
    const warn = jest.spyOn(console, "warn").mockImplementation(() => {});
    // Turso second-precision Date + text-json; PG sub-second Date + object jsonb (keys reordered).
    const tursoRow = { ts: new Date(1749081599000), resp: '{"a":1,"b":2}' };
    const pgRow = { ts: new Date(1749081599842), resp: { b: 2, a: 1 } };
    const normalize = (v: unknown) => {
      const r = v as { ts: Date; resp: unknown };
      return { ts: toEpochSeconds(r.ts), resp: normalizeJson(r.resp) };
    };
    const out = await shadowReadConfig("polling", async () => tursoRow, {
      pgRead: async () => pgRow,
      normalize,
      diffKey: "1",
    });
    expect(out).toBe(tursoRow);
    expect(warn).not.toHaveBeenCalled(); // normalized projections are equal
    warn.mockRestore();
  });
});
