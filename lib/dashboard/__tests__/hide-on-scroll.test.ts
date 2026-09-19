import { describe, expect, it } from "@jest/globals";
import { scrollStep, type ScrollStep } from "../useHideOnScroll";

const H = 100; // header height
const PAGE = 5000; // a settled page height

const at = (y: number, hidden = false, height = PAGE): ScrollStep => ({
  hidden,
  lastY: y,
  lastHeight: height,
});

describe("scrollStep", () => {
  it("never hides within the header's own height of the top", () => {
    expect(scrollStep(at(0), 80, PAGE, H).hidden).toBe(false);
    expect(scrollStep(at(150, true), 90, PAGE, H).hidden).toBe(false);
  });

  it("hides on a downward step past the header", () => {
    expect(scrollStep(at(120), 140, PAGE, H).hidden).toBe(true);
  });

  it("shows again on ANY upward step", () => {
    expect(scrollStep(at(900, true), 899, PAGE, H).hidden).toBe(false);
  });

  it("keeps its state when the position did not move", () => {
    expect(scrollStep(at(500, true), 500, PAGE, H).hidden).toBe(true);
    expect(scrollStep(at(500, false), 500, PAGE, H).hidden).toBe(false);
  });

  it("ignores a step whose page height changed — that is layout, not the reader", () => {
    // Chrome's scroll anchoring bumping scrollY as the Y-period charts grow above the viewport.
    const grown = scrollStep(at(900), 1200, PAGE + 300, H);
    expect(grown.hidden).toBe(false);
    expect(grown.lastY).toBe(1200); // baseline resynced, so the next real step is measured from here
    expect(grown.lastHeight).toBe(PAGE + 300);
    // A shrinking page clamping the scroll must not flip it either.
    expect(scrollStep(at(900, true), 700, PAGE - 400, H).hidden).toBe(true);
  });

  it("decides normally on the next step once the height has settled", () => {
    const settled = scrollStep(
      at(1200, false, PAGE + 300),
      1260,
      PAGE + 300,
      H,
    );
    expect(settled.hidden).toBe(true);
  });
});
