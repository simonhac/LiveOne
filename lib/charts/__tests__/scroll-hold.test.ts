import { describe, expect, it } from "@jest/globals";
import { pickAnchor } from "../scroll-hold";

const box = (top: number, bottom: number) => ({ top, bottom });

describe("pickAnchor", () => {
  it("picks the smallest box straddling the line (innermost block, not its card)", () => {
    const card = box(-800, 800); // the whole site-charts card
    const sankey = box(-100, 624); // the sankey block inside it
    const table = box(-800, -397); // a stacked chart above, off screen
    expect(pickAnchor([card, table, sankey], 60)).toBe(2);
  });

  it("falls back to the first box starting below the line", () => {
    expect(pickAnchor([box(-300, -10), box(400, 500), box(120, 300)], 60)).toBe(
      2,
    );
  });

  it("treats a box ending exactly on the line as above it", () => {
    expect(pickAnchor([box(0, 60), box(60, 200)], 60)).toBe(1);
  });

  it("ignores zero-height (hidden) boxes", () => {
    expect(pickAnchor([box(60, 60), box(10, 400)], 60)).toBe(1);
  });

  it("returns -1 when there is nothing on or below the line", () => {
    expect(pickAnchor([box(-300, -10)], 60)).toBe(-1);
    expect(pickAnchor([], 0)).toBe(-1);
  });
});
