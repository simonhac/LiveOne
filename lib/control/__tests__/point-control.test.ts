/**
 * The pure half of the command plane: what a control descriptor accepts, and when two
 * descriptors are the same.
 *
 * `pointControlEquals` is load-bearing beyond the obvious: it gates the mint heal on the HOT
 * INGEST PATH (one call per reading per poll per vendor). If it reported spurious drift, every
 * poll would re-upsert every controllable point forever — which is exactly what a
 * `JSON.stringify` comparison would do, because jsonb does not preserve object key order. The
 * key-order case below is that regression test.
 */
import { describe, it, expect } from "@jest/globals";
import type { PointControl } from "@/lib/db/planetscale/schema";
import {
  POINT_ACTION_NAMES,
  isPointActionName,
  pointControlEquals,
  validatePointAction,
} from "../point-control";

const SWITCH: PointControl = { kind: "switch" };
const BUTTON: PointControl = { kind: "button" };
const NUMBER: PointControl = { kind: "number", min: 50, max: 100, step: 1 };

describe("validatePointAction", () => {
  it("rejects any action on a point with no control descriptor", () => {
    for (const control of [null, undefined] as const) {
      const r = validatePointAction(control, "turn_on", undefined);
      expect(r).toEqual({ ok: false, error: "Point is not controllable" });
    }
  });

  it("rejects an action outside the closed vocabulary", () => {
    const r = validatePointAction(SWITCH, "explode", undefined);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toContain("Invalid action");
  });

  describe("switch", () => {
    it("accepts turn_on and turn_off", () => {
      expect(validatePointAction(SWITCH, "turn_on", undefined)).toEqual({
        ok: true,
      });
      expect(validatePointAction(SWITCH, "turn_off", undefined)).toEqual({
        ok: true,
      });
    });

    it("rejects set_value and press", () => {
      expect(validatePointAction(SWITCH, "set_value", 1).ok).toBe(false);
      expect(validatePointAction(SWITCH, "press", undefined).ok).toBe(false);
    });

    it("rejects a value on turn_on/turn_off", () => {
      const r = validatePointAction(SWITCH, "turn_on", 42);
      expect(r.ok).toBe(false);
      if (!r.ok) expect(r.error).toContain("does not take a value");
    });
  });

  describe("button", () => {
    it("accepts press only", () => {
      expect(validatePointAction(BUTTON, "press", undefined)).toEqual({
        ok: true,
      });
      expect(validatePointAction(BUTTON, "turn_on", undefined).ok).toBe(false);
      expect(validatePointAction(BUTTON, "set_value", 3).ok).toBe(false);
    });

    it("rejects a value on press", () => {
      expect(validatePointAction(BUTTON, "press", 1).ok).toBe(false);
    });
  });

  describe("number", () => {
    it("accepts set_value at min, at max and in between", () => {
      expect(validatePointAction(NUMBER, "set_value", 50)).toEqual({ ok: true });
      expect(validatePointAction(NUMBER, "set_value", 100)).toEqual({
        ok: true,
      });
      expect(validatePointAction(NUMBER, "set_value", 80)).toEqual({ ok: true });
    });

    it("does NOT enforce step — the vendor client rounds anyway", () => {
      expect(validatePointAction(NUMBER, "set_value", 80.5)).toEqual({
        ok: true,
      });
    });

    it("rejects below min and above max", () => {
      const low = validatePointAction(NUMBER, "set_value", 49);
      expect(low.ok).toBe(false);
      if (!low.ok) expect(low.error).toContain("out of range");
      expect(validatePointAction(NUMBER, "set_value", 101).ok).toBe(false);
    });

    it("rejects non-finite and non-numeric values", () => {
      expect(validatePointAction(NUMBER, "set_value", NaN).ok).toBe(false);
      expect(validatePointAction(NUMBER, "set_value", Infinity).ok).toBe(false);
      expect(validatePointAction(NUMBER, "set_value", "80").ok).toBe(false);
    });

    it("rejects a missing value", () => {
      const r = validatePointAction(NUMBER, "set_value", undefined);
      expect(r.ok).toBe(false);
      if (!r.ok) expect(r.error).toContain("numeric value");
    });

    it("rejects turn_on / press", () => {
      expect(validatePointAction(NUMBER, "turn_on", undefined).ok).toBe(false);
      expect(validatePointAction(NUMBER, "press", undefined).ok).toBe(false);
    });
  });
});

describe("isPointActionName", () => {
  it("accepts exactly the four names", () => {
    for (const name of POINT_ACTION_NAMES) expect(isPointActionName(name)).toBe(true);
    expect(isPointActionName("toggle")).toBe(false);
    expect(isPointActionName(7)).toBe(false);
  });
});

describe("pointControlEquals", () => {
  it("treats null and undefined as the same (no control)", () => {
    expect(pointControlEquals(null, null)).toBe(true);
    expect(pointControlEquals(null, undefined)).toBe(true);
    expect(pointControlEquals(undefined, undefined)).toBe(true);
  });

  it("distinguishes no-control from a control", () => {
    expect(pointControlEquals(null, SWITCH)).toBe(false);
    expect(pointControlEquals(SWITCH, null)).toBe(false);
  });

  it("compares kinds", () => {
    expect(pointControlEquals(SWITCH, { kind: "switch" })).toBe(true);
    expect(pointControlEquals(BUTTON, { kind: "button" })).toBe(true);
    expect(pointControlEquals(SWITCH, BUTTON)).toBe(false);
    expect(pointControlEquals(SWITCH, NUMBER)).toBe(false);
  });

  it("compares number bounds field-wise", () => {
    expect(pointControlEquals(NUMBER, { kind: "number", min: 50, max: 100, step: 1 })).toBe(true);
    expect(pointControlEquals(NUMBER, { kind: "number", min: 0, max: 100, step: 1 })).toBe(false);
    expect(pointControlEquals(NUMBER, { kind: "number", min: 50, max: 90, step: 1 })).toBe(false);
    expect(pointControlEquals(NUMBER, { kind: "number", min: 50, max: 100, step: 5 })).toBe(false);
  });

  it("treats an absent step as undefined", () => {
    const a: PointControl = { kind: "number", min: 0, max: 48 };
    const b: PointControl = { kind: "number", min: 0, max: 48, step: undefined };
    expect(pointControlEquals(a, b)).toBe(true);
    expect(pointControlEquals(a, { kind: "number", min: 0, max: 48, step: 1 })).toBe(false);
  });

  it("🛑 is insensitive to key order — the jsonb round-trip case", () => {
    // Postgres returns jsonb with its own key order. A JSON.stringify comparison would call
    // these two different and re-upsert the point on EVERY poll, forever.
    const fromPg = JSON.parse('{"max":100,"min":50,"kind":"number","step":1}') as PointControl;
    expect(pointControlEquals(fromPg, NUMBER)).toBe(true);
    expect(JSON.stringify(fromPg)).not.toBe(JSON.stringify(NUMBER)); // the trap is real
  });
});
