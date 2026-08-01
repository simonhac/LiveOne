import { describe, it, expect } from "@jest/globals";
import { DEFAULT_MARGIN, buildGeometry, niceDomain } from "../geometry";

const base = {
  width: 900,
  height: 300,
  xDomain: [new Date(2026, 5, 14, 12), new Date(2026, 5, 15, 12)] as [
    Date,
    Date,
  ],
  yDomain: [0, 10] as [number, number],
};

describe("buildGeometry", () => {
  it("insets the plot area by the margins", () => {
    const g = buildGeometry(base);
    expect(g.plot.width).toBe(900 - DEFAULT_MARGIN.left - DEFAULT_MARGIN.right);
    expect(g.plot.height).toBe(
      300 - DEFAULT_MARGIN.top - DEFAULT_MARGIN.bottom,
    );
    expect(g.plot.left).toBe(DEFAULT_MARGIN.left);
    expect(g.plot.top).toBe(DEFAULT_MARGIN.top);
    expect(g.empty).toBe(false);
  });

  it("maps the x domain across the plot width", () => {
    const g = buildGeometry(base);
    expect(g.x(base.xDomain[0])).toBeCloseTo(0, 6);
    expect(g.x(base.xDomain[1])).toBeCloseTo(g.plot.width, 6);
  });

  it("inverts y, because SVG grows downward", () => {
    const g = buildGeometry(base);
    expect(g.y(0)).toBeCloseTo(g.plot.height, 6); // domain min at the bottom
    expect(g.y(10)).toBeCloseTo(0, 6); // domain max at the top
  });

  it("omits y1 unless a second domain is asked for", () => {
    expect(buildGeometry(base).y1).toBeUndefined();
    const dual = buildGeometry({ ...base, y1Domain: [0, 100] });
    expect(dual.y1).toBeDefined();
    expect(dual.y1!(100)).toBeCloseTo(0, 6);
    expect(dual.y1!(0)).toBeCloseTo(dual.plot.height, 6);
  });

  it("flags an unmeasured container as empty rather than throwing", () => {
    // The normal first render, before ResizeObserver reports — not an error.
    expect(buildGeometry({ ...base, width: 0, height: 0 }).empty).toBe(true);
    expect(buildGeometry({ ...base, width: 10, height: 300 }).empty).toBe(true);
  });

  it("never produces a negative plot box for a tiny container", () => {
    const g = buildGeometry({ ...base, width: 4, height: 4 });
    expect(g.plot.width).toBeGreaterThanOrEqual(0);
    expect(g.plot.height).toBeGreaterThanOrEqual(0);
  });

  it("accepts a partial margin override", () => {
    const g = buildGeometry({ ...base, margin: { left: 100 } });
    expect(g.plot.left).toBe(100);
    expect(g.plot.width).toBe(900 - 100 - DEFAULT_MARGIN.right);
  });
});

describe("niceDomain", () => {
  it("anchors at zero for all-positive data", () => {
    const [lo, hi] = niceDomain([1, 5, 9]);
    expect(lo).toBe(0);
    expect(hi).toBeGreaterThan(9); // headroom
  });

  it("keeps room below zero when the data goes negative", () => {
    // Battery charging and grid export both do — clamping to zero would clip the trace.
    const [lo, hi] = niceDomain([-4, 2]);
    expect(lo).toBeLessThan(-4);
    expect(hi).toBeGreaterThan(2);
  });

  it("ignores nulls and non-finite values", () => {
    expect(niceDomain([null, 3, undefined, NaN, Infinity, 1])).toEqual(
      niceDomain([3, 1]),
    );
  });

  it("stays non-degenerate for an all-zero series", () => {
    const [lo, hi] = niceDomain([0, 0, 0]);
    expect(hi).toBeGreaterThan(lo);
  });

  it("stays non-degenerate when there is no data at all", () => {
    const [lo, hi] = niceDomain([]);
    expect(hi).toBeGreaterThan(lo);
    expect(niceDomain([null, null])).toEqual([lo, hi]);
  });

  it("honours a suggestedMax floor without shrinking real data", () => {
    // maxPowerHint: hold the axis open on a quiet day, but never crop a busy one.
    expect(niceDomain([1, 2], { suggestedMax: 10 })[1]).toBeGreaterThanOrEqual(
      10,
    );
    expect(niceDomain([1, 50], { suggestedMax: 10 })[1]).toBeGreaterThan(50);
  });
});

describe("buildGeometry — nice() domains", () => {
  /**
   * Without `.nice()` the top gridline can sit below the data: `ticks()` picks round numbers inside
   * the padded domain, so a series peaking at 9 in a 0–9.4 domain draws past a last tick of 5.
   */
  it("snaps the y domain out so the top tick reaches the data", () => {
    const g = buildGeometry({ ...base, yDomain: niceDomain([0, 9]) });
    const ticks = g.y.ticks(6);
    const topTick = ticks[ticks.length - 1];
    expect(topTick).toBeGreaterThanOrEqual(9);
    expect(g.y.domain()[1]).toBeGreaterThanOrEqual(topTick);
  });

  it("leaves an already-round domain alone", () => {
    const g = buildGeometry({ ...base, y1Domain: [0, 100] });
    expect(g.y1!.domain()).toEqual([0, 100]);
  });

  it("keeps negative room after snapping", () => {
    const g = buildGeometry({ ...base, yDomain: niceDomain([-4, 9]) });
    expect(g.y.domain()[0]).toBeLessThanOrEqual(-4);
  });
});
