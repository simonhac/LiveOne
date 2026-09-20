import { describe, expect, it } from "@jest/globals";
import { placeHeader, type HeaderPlacement } from "../useHideOnScroll";

const H = 100; // header height
const PAGE = 5000; // a settled page height

/** Stuck, and armed to start leaving at scroll offset `at`. */
const stuck = (at: number, y = at, height = PAGE): HeaderPlacement => ({
  mode: "stuck",
  top: at,
  lastY: y,
  lastHeight: height,
});
const free = (top: number, y: number, height = PAGE): HeaderPlacement => ({
  mode: "free",
  top,
  lastY: y,
  lastHeight: height,
});

/** Where a FREE header's top edge is on screen at 1px per px: -H or less = gone. */
const onScreen = (p: HeaderPlacement) => p.top - p.lastY;

describe("placeHeader", () => {
  it("leaves a stuck header to CSS while it is mid-leave, in either direction", () => {
    // Armed at 500, H of travel: anywhere in [500, 600) the scroll-driven animation owns it.
    for (const y of [501, 540, 599, 560, 500]) {
      expect(placeHeader(stuck(500, 520), y, PAGE, H)).toMatchObject({
        mode: "stuck",
        top: 500,
      });
    }
  });

  it("hands it to the free host once it is fully out of sight, parked where it already is", () => {
    const next = placeHeader(stuck(500, 590), 600, PAGE, H);
    expect(next).toMatchObject({ mode: "free", top: 500 });
    expect(onScreen(next)).toBe(-100);
    // …and a fling that overshoots the whole journey in one step ends up in the same place.
    expect(placeHeader(stuck(500), 1400, PAGE, H)).toMatchObject({
      mode: "free",
      top: 500,
    });
  });

  it("re-arms a stuck header as the reader scrolls UP, so a turn back leaves from where they turned", () => {
    expect(placeHeader(stuck(500), 430, PAGE, H)).toMatchObject({
      mode: "stuck",
      top: 430,
    });
  });

  it("re-parks a header that is out of sight just above the viewport on ANY upward step", () => {
    const next = placeHeader(free(500, 900), 899, PAGE, H);
    expect(next).toMatchObject({ mode: "free", top: 799 });
    expect(onScreen(next)).toBe(-100); // just out of sight: it enters from rest on the next step
    expect(onScreen(placeHeader(next, 890, PAGE, H))).toBe(-91);
  });

  it("does not move a header that is still partly on screen when the reader turns back", () => {
    const next = placeHeader(free(500, 560), 540, PAGE, H);
    expect(next).toMatchObject({ mode: "free", top: 500 });
    expect(onScreen(next)).toBe(-40);
  });

  it("sticks once the viewport's top edge reaches it", () => {
    expect(placeHeader(free(800, 830), 800, PAGE, H)).toMatchObject({
      mode: "stuck",
      top: 800,
    });
    // …armed where the reader now IS, not where it was parked.
    expect(placeHeader(free(800, 830), 640, PAGE, H)).toMatchObject({
      mode: "stuck",
      top: 640,
    });
    // A step longer than the header still only re-parks: it enters from rest, never mid-way.
    expect(placeHeader(free(500, 900), 700, PAGE, H)).toMatchObject({
      mode: "free",
      top: 600,
    });
  });

  it("never parks above the top of the page", () => {
    expect(placeHeader(free(0, 120), 110, PAGE, H)).toMatchObject({
      mode: "free",
      top: 10,
    });
    expect(placeHeader(free(0, 60), 50, PAGE, H).top).toBe(0);
  });

  it("keeps its placement when the position did not move", () => {
    expect(placeHeader(stuck(500), 500, PAGE, H)).toMatchObject({
      mode: "stuck",
      top: 500,
    });
    expect(placeHeader(free(500, 900), 900, PAGE, H)).toMatchObject({
      mode: "free",
      top: 500,
    });
  });

  it("carries the arming point along on a step whose page height changed — layout, not the reader", () => {
    // Chrome's scroll anchoring bumping scrollY as the Y-period charts grow above the viewport.
    const grown = placeHeader(stuck(900), 1200, PAGE + 300, H);
    expect(grown).toMatchObject({ mode: "stuck", top: 1200, lastY: 1200 });
    expect(grown.lastHeight).toBe(PAGE + 300);
    // A header 30px into its leave is still 30px into it afterwards: no leave, and no snap back.
    expect(placeHeader(stuck(900, 930), 1230, PAGE + 300, H)).toMatchObject({
      mode: "stuck",
      top: 1200,
    });
    // A shrinking page clamping the scroll must not bring a free one back either.
    expect(placeHeader(free(500, 900), 700, PAGE - 400, H)).toMatchObject({
      mode: "free",
      top: 500,
    });
  });

  it("without scroll timelines, JS releases it on a downward step, from where the page is", () => {
    const next = placeHeader(stuck(0, 500), 520, PAGE, H, false);
    expect(next).toMatchObject({ mode: "free", top: 520 });
    expect(placeHeader(stuck(0, 500), 480, PAGE, H, false).mode).toBe("stuck");
    // …and a layout step decides nothing.
    expect(placeHeader(stuck(0, 900), 1200, PAGE + 300, H, false).mode).toBe(
      "stuck",
    );
  });

  it("at double speed, half the header's height of scroll is the whole journey", () => {
    const travel = H / 2;
    // Out of sight once it is more than `travel` px behind, so an upward step re-parks it…
    const back = placeHeader(free(500, 560), 540, PAGE, travel);
    expect(back).toMatchObject({ mode: "free", top: 540 - travel });
    // …and it is home `travel` px of scroll later, not `H`.
    expect(placeHeader(back, 540 - travel, PAGE, travel).mode).toBe("stuck");
    // Still partly showing short of that, so a turn-back leaves it where it is.
    expect(placeHeader(free(500, 520), 510, PAGE, travel)).toMatchObject({
      mode: "free",
      top: 500,
    });
  });
});
