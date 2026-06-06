import { describe, it, expect, jest, beforeEach } from "@jest/globals";

// Control the routing flags per-test via getter mocks. config-shadow accesses each as a
// module property (routing_1.CONFIG_READS_FROM_PG, routing_1.CONFIG_SERVE_FROM_PG), so the
// getters are re-evaluated on every read — no module reloading needed.
let mockFlagOn = false;
let mockServeOn = false;
jest.mock("../routing", () => ({
  get CONFIG_READS_FROM_PG() {
    return mockFlagOn;
  },
  get CONFIG_SERVE_FROM_PG() {
    return mockServeOn;
  },
}));

import {
  shadowReadConfig,
  stableStringify,
  toEpochSeconds,
  normalizeJson,
  compareNormalized,
  SHADOW_SKIP,
} from "../config-shadow";

beforeEach(() => {
  mockFlagOn = false;
  mockServeOn = false;
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

  it("SERVE ON: returns the PG value and NEVER calls tursoRead", async () => {
    mockServeOn = true;
    const tursoRead = jest.fn(async () => ({ x: 1 }));
    const out = await shadowReadConfig("t", tursoRead, {
      pgRead: async () => ({ x: 2 }),
      normalize: (v) => v,
    });
    expect(out).toEqual({ x: 2 }); // served FROM Postgres
    expect(tursoRead).not.toHaveBeenCalled();
  });

  it("SERVE ON: maps the PG read through toServed", async () => {
    mockServeOn = true;
    const tursoRead = jest.fn(async () => ({ x: 1 }));
    const out = await shadowReadConfig<{ x: number }>("t", tursoRead, {
      pgRead: async () => ({ raw: 41 }),
      normalize: (v) => v,
      toServed: (pg) => ({ x: (pg as { raw: number }).raw + 1 }),
    });
    expect(out).toEqual({ x: 42 });
    expect(tursoRead).not.toHaveBeenCalled();
  });

  it("SERVE ON + pgRead throws: falls back to the Turso value and logs an error", async () => {
    mockServeOn = true;
    const error = jest.spyOn(console, "error").mockImplementation(() => {});
    const tursoRead = jest.fn(async () => ({ x: 1 }));
    const out = await shadowReadConfig("t", tursoRead, {
      pgRead: async () => {
        throw new Error("pg down");
      },
      normalize: (v) => v,
      diffKey: "7",
    });
    expect(out).toEqual({ x: 1 }); // Turso safety-net fallback
    expect(tursoRead).toHaveBeenCalledTimes(1);
    expect(error).toHaveBeenCalledTimes(1);
    error.mockRestore();
  });

  it("SERVE ON + pgRead returns SHADOW_SKIP: falls through to the Turso value", async () => {
    mockServeOn = true;
    const warn = jest.spyOn(console, "warn").mockImplementation(() => {});
    const error = jest.spyOn(console, "error").mockImplementation(() => {});
    const tursoRead = jest.fn(async () => ({ x: 1 }));
    const out = await shadowReadConfig("t", tursoRead, {
      pgRead: async () => SHADOW_SKIP,
      normalize: (v) => v,
    });
    expect(out).toEqual({ x: 1 }); // PG unconfigured → Turso
    expect(tursoRead).toHaveBeenCalledTimes(1);
    expect(warn).not.toHaveBeenCalled();
    expect(error).not.toHaveBeenCalled();
    warn.mockRestore();
    error.mockRestore();
  });

  it("SERVE ON takes precedence over READS_FROM_PG: serves PG, no shadow compare", async () => {
    mockServeOn = true;
    mockFlagOn = true;
    const warn = jest.spyOn(console, "warn").mockImplementation(() => {});
    const tursoRead = jest.fn(async () => ({ x: 1 }));
    const pgRead = jest.fn(async () => ({ x: 2 }));
    const out = await shadowReadConfig("t", tursoRead, {
      pgRead,
      normalize: (v) => v,
    });
    expect(out).toEqual({ x: 2 }); // served FROM Postgres
    expect(tursoRead).not.toHaveBeenCalled();
    expect(pgRead).toHaveBeenCalledTimes(1); // only the serve read, no extra shadow read
    expect(warn).not.toHaveBeenCalled(); // no compare in serve mode
    warn.mockRestore();
  });
});
