import { describe, expect, it } from "@jest/globals";
import { placeHeader, type HeaderPlacement } from "../useHideOnScroll";

const H = 100; // header height
const PAGE = 5000; // a settled page height

const stuck = (y: number, height = PAGE): HeaderPlacement => ({
  mode: "stuck",
  top: 0,
  lastY: y,
  lastHeight: height,
});
const free = (top: number, y: number, height = PAGE): HeaderPlacement => ({
  mode: "free",
  top,
  lastY: y,
  lastHeight: height,
});

/** Where the header's top edge is on screen: 0 = fully shown, -H or less = gone. */
const onScreen = (p: HeaderPlacement) =>
  p.mode === "stuck" ? 0 : p.top - p.lastY;

describe("placeHeader", () => {
  it("lets go on a downward step, exactly where the header was", () => {
    const next = placeHeader(stuck(500), 520, PAGE, H);
    expect(next).toMatchObject({ mode: "free", top: 500 });
    expect(onScreen(next)).toBe(-20); // 20px of scroll took 20px of header
  });

  it("then leaves it alone: the page carries it, pixel for pixel", () => {
    let p = placeHeader(stuck(500), 520, PAGE, H);
    for (const y of [545, 590, 700, 1400]) {
      p = placeHeader(p, y, PAGE, H);
      expect(p).toMatchObject({ mode: "free", top: 500 });
    }
  });

  it("from the top of the page it goes from its natural place", () => {
    expect(placeHeader(stuck(0), 30, PAGE, H)).toMatchObject({
      mode: "free",
      top: 0,
    });
  });

  it("re-parks a header that is out of sight just above the viewport on ANY upward step", () => {
    const next = placeHeader(free(500, 900), 899, PAGE, H);
    expect(next).toMatchObject({ mode: "free", top: 800 });
    expect(onScreen(next)).toBe(-99); // 1px of scroll brought in 1px of header
  });

  it("does not move a header that is still partly on screen when the reader turns back", () => {
    const next = placeHeader(free(500, 560), 540, PAGE, H);
    expect(next).toMatchObject({ mode: "free", top: 500 });
    expect(onScreen(next)).toBe(-40);
  });

  it("sticks once the viewport's top edge reaches it", () => {
    expect(placeHeader(free(800, 830), 800, PAGE, H).mode).toBe("stuck");
    expect(placeHeader(free(800, 830), 640, PAGE, H).mode).toBe("stuck");
    // …including in the very step that re-parked it, when that step is longer than the header.
    expect(placeHeader(free(500, 900), 700, PAGE, H).mode).toBe("stuck");
  });

  it("never parks above the top of the page", () => {
    expect(placeHeader(free(0, 120), 110, PAGE, H)).toMatchObject({
      mode: "free",
      top: 20,
    });
    expect(placeHeader(free(0, 60), 50, PAGE, H).top).toBe(0);
  });

  it("keeps its placement when the position did not move", () => {
    expect(placeHeader(stuck(500), 500, PAGE, H).mode).toBe("stuck");
    expect(placeHeader(free(500, 900), 900, PAGE, H)).toMatchObject({
      mode: "free",
      top: 500,
    });
  });

  it("ignores the direction of a step whose page height changed — that is layout, not the reader", () => {
    // Chrome's scroll anchoring bumping scrollY as the Y-period charts grow above the viewport.
    const grown = placeHeader(stuck(900), 1200, PAGE + 300, H);
    expect(grown.mode).toBe("stuck");
    expect(grown.lastY).toBe(1200); // baseline resynced, so the next real step is measured from here
    expect(grown.lastHeight).toBe(PAGE + 300);
    // A shrinking page clamping the scroll must not bring it back either.
    expect(placeHeader(free(500, 900), 700, PAGE - 400, H)).toMatchObject({
      mode: "free",
      top: 500,
    });
  });

  it("decides normally on the next step once the height has settled", () => {
    const settled = placeHeader(stuck(1200, PAGE + 300), 1260, PAGE + 300, H);
    expect(settled).toMatchObject({ mode: "free", top: 1200 });
  });
});
