import { describe, expect, it } from "@jest/globals";
import {
  panelCentreY,
  panelHorizontal,
  panelTop,
  toPagePosition,
  type PanelHorizontalInput,
} from "../sankey-panel-placement";

const PANEL_WIDTH = 140;
const GAP = 12;
const PAD = 8;

/**
 * The real `clampX` from `EnergyFlowSankey`: keep the panel's left edge inside the viewport, padded.
 */
const clampFor = (viewportWidth: number) => (l: number) =>
  Math.max(PAD, Math.min(l, viewportWidth - PANEL_WIDTH - PAD));

/**
 * One laid-out Sankey, as the placement effect sees it.
 *
 * `svgLeftVp` is where the svg's left edge lands in the page: 0 on mobile (the diagram spans the
 * viewport), non-zero on desktop, where that margin is the room a panel normally sits in.
 */
function scenario(opts: {
  viewportWidth: number;
  svgWidth: number;
  svgLeftVp?: number;
  columns: { x0: number; x1: number }[];
}) {
  const svgLeftVp = opts.svgLeftVp ?? 0;
  return (side: "left" | "right", columnIndex: number) => {
    const col = opts.columns[columnIndex];
    const input: PanelHorizontalInput = {
      side,
      node: {
        leftVp: svgLeftVp + col.x0,
        rightVp: svgLeftVp + col.x1,
        x0: col.x0,
        x1: col.x1,
      },
      columns: opts.columns,
      svg: { leftVp: svgLeftVp, scaleX: 1, width: opts.svgWidth },
      panelWidth: PANEL_WIDTH,
      gap: GAP,
      clampX: clampFor(opts.viewportWidth),
    };
    return { ...panelHorizontal(input), node: input.node };
  };
}

/** A Pixel 7: 393px wide, no side margins, so the columns hug the viewport edges. */
const PHONE_COLUMNS = scenario({
  viewportWidth: 393,
  svgWidth: 393,
  // `battery-middle` on mobile: nodeWidth 72, three columns spread across the full width.
  columns: [
    { x0: 0, x1: 72 },
    { x0: 160.5, x1: 232.5 },
    { x0: 321, x1: 393 },
  ],
});

/** The same phone in the two-column `columns` layout, where mobile nodeWidth is 86. */
const PHONE_BIPARTITE = scenario({
  viewportWidth: 393,
  svgWidth: 393,
  columns: [
    { x0: 0, x1: 86 },
    { x0: 307, x1: 393 },
  ],
});

describe("panelHorizontal", () => {
  describe("desktop, with page margin beside the diagram", () => {
    // A 600px svg centred in a 1400px window: ~400px of page either side, far more than a panel needs.
    const desktop = scenario({
      viewportWidth: 1400,
      svgWidth: 600,
      svgLeftVp: 400,
      columns: [
        { x0: 60, x1: 156 },
        { x0: 444, x1: 540 },
      ],
    });

    it("puts a left-column panel outside the diagram, unflipped and beaked", () => {
      const p = desktop("left", 0);
      expect(p.side).toBe("left");
      // Hard against the node's outer edge, one gap clear.
      expect(p.left + PANEL_WIDTH).toBe(p.node.leftVp - GAP);
      expect(p.overlapsNode).toBe(false);
    });

    it("puts a right-column panel outside the diagram, unflipped and beaked", () => {
      const p = desktop("right", 1);
      expect(p.side).toBe("right");
      expect(p.left).toBe(p.node.rightVp + GAP);
      expect(p.overlapsNode).toBe(false);
    });
  });

  describe("a window barely wider than the diagram (the laptop case)", () => {
    // The 600px svg centred in a 656px window: ~28px of page either side of it, and the diagram's
    // own 60px margins inside that. Nothing like enough for a 140px panel OUTSIDE the node, but
    // plenty beside it on the inside.
    const snug = scenario({
      viewportWidth: 656,
      svgWidth: 600,
      svgLeftVp: 28,
      // Desktop `nodeWidth` 96, `margin.left/right` 60.
      columns: [
        { x0: 60, x1: 156 },
        { x0: 444, x1: 540 },
      ],
    });

    it("puts the SOURCES panel against the node, not adrift in the middle", () => {
      // 🛑 Not centred in the sources↔loads channel. Centring reads as a card floating in the middle
      // of the diagram with a beak aimed across empty space at a node some distance away; hanging it
      // off the node's inner edge keeps the beak short and the subject unambiguous.
      const p = snug("left", 0);
      expect(p.side).toBe("right");
      expect(p.left).toBe(p.node.rightVp + GAP);
      expect(p.overlapsNode).toBe(false);
    });

    it("puts the LOADS panel against the node too", () => {
      const p = snug("right", 1);
      expect(p.side).toBe("left");
      expect(p.left + PANEL_WIDTH).toBe(p.node.leftVp - GAP);
      expect(p.overlapsNode).toBe(false);
    });

    it("still goes OUTSIDE the diagram once the window has room for it", () => {
      // The same diagram in a 1400px window: ~400px of page either side, so the panel returns to the
      // margin and the flip never happens. The inward placement is a fallback, not a new default.
      const roomy = scenario({
        viewportWidth: 1400,
        svgWidth: 600,
        svgLeftVp: 400,
        columns: [
          { x0: 60, x1: 156 },
          { x0: 444, x1: 540 },
        ],
      });
      const p = roomy("left", 0);
      expect(p.side).toBe("left");
      expect(p.left + PANEL_WIDTH).toBe(p.node.leftVp - GAP);
    });
  });

  describe("phone, battery-middle — the case that used to lose its beak", () => {
    it("flips the LEFT column's panel inward and keeps it clear of the node", () => {
      const p = PHONE_COLUMNS("left", 0);
      // Flipped to the node's inner side: the beak now hangs off the panel's LEFT edge, pointing
      // back at the column it came from.
      expect(p.side).toBe("right");
      expect(p.left).toBe(p.node.rightVp + GAP);
      // 🛑 The regression this guards. Centred in the ~88px channel the panel landed at 46 and
      // straddled the node, which forced `beakVariant: "none"`.
      expect(p.overlapsNode).toBe(false);
    });

    it("flips the RIGHT column's panel inward and keeps it clear of the node", () => {
      const p = PHONE_COLUMNS("right", 2);
      expect(p.side).toBe("left");
      expect(p.left + PANEL_WIDTH).toBe(p.node.leftVp - GAP);
      expect(p.overlapsNode).toBe(false);
    });

    it("leaves the INTERIOR node's dual panels on their own sides", () => {
      // Flipping here would swap the battery's two panels, putting the left one's content on the
      // right. The centre column has room beside it on both sides, so neither flips.
      const l = PHONE_COLUMNS("left", 1);
      const r = PHONE_COLUMNS("right", 1);
      expect(l.side).toBe("left");
      expect(r.side).toBe("right");
      expect(l.left + PANEL_WIDTH).toBeLessThanOrEqual(l.node.leftVp);
      expect(r.left).toBeGreaterThanOrEqual(r.node.rightVp);
      expect(l.overlapsNode).toBe(false);
      expect(r.overlapsNode).toBe(false);
    });
  });

  describe("phone, two-column layout", () => {
    it.each([
      ["left", 0, "right"],
      ["right", 1, "left"],
    ] as const)(
      "flips the %s column inward and keeps its beak",
      (side, column, expected) => {
        const p = PHONE_BIPARTITE(side, column);
        expect(p.side).toBe(expected);
        expect(p.overlapsNode).toBe(false);
      },
    );
  });

  describe("no room anywhere", () => {
    it("gives up the beak rather than pointing at a node the panel covers", () => {
      // A viewport barely wider than the panel: `clampX` has nowhere to put it but over the node.
      const cramped = scenario({
        viewportWidth: 160,
        svgWidth: 160,
        columns: [
          { x0: 0, x1: 60 },
          { x0: 100, x1: 160 },
        ],
      });
      expect(cramped("left", 0).overlapsNode).toBe(true);
    });
  });

  describe("degenerate input", () => {
    it("centres on the svg when the node's column cannot be found", () => {
      // `columns` empty ⇒ `findIndex` is -1 ⇒ neither the flip nor a neighbour applies, and the
      // panel falls back to the middle of the diagram.
      const p = panelHorizontal({
        side: "left",
        node: { leftVp: 0, rightVp: 72, x0: 0, x1: 72 },
        columns: [],
        svg: { leftVp: 0, scaleX: 1, width: 393 },
        panelWidth: PANEL_WIDTH,
        gap: GAP,
        clampX: clampFor(393),
      });
      expect(p.side).toBe("left");
      expect(p.left).toBe(393 / 2 - PANEL_WIDTH / 2);
    });
  });
});

describe("panelTop", () => {
  /** A diagram sitting in view: nodes from y=100 to y=700. */
  const BAND = { top: 100, bottom: 700 };

  it("leaves a panel that already fits exactly where the node wants it", () => {
    expect(panelTop({ desiredTop: 300, band: BAND, panelHeight: 200 })).toBe(
      300,
    );
  });

  it("keeps the panel inside the node band", () => {
    // Above the topmost node — pulled down to the band's top.
    expect(panelTop({ desiredTop: 20, band: BAND, panelHeight: 200 })).toBe(
      100,
    );
    // Past the bottommost node — pulled up so its BOTTOM edge lands on the band's.
    expect(panelTop({ desiredTop: 690, band: BAND, panelHeight: 200 })).toBe(
      500,
    );
  });

  it("pins a panel taller than the band to its top", () => {
    expect(panelTop({ desiredTop: 300, band: BAND, panelHeight: 1000 })).toBe(
      100,
    );
  });
});

describe("panelCentreY", () => {
  const BAND = { top: 100, bottom: 700 };

  it("is panelTop expressed in centres", () => {
    expect(
      panelCentreY({ desiredCentre: 400, band: BAND, panelHeight: 60 }),
    ).toBe(400);
  });

  it("clamps a card near the band's end by its edge, not its centre", () => {
    expect(
      panelCentreY({ desiredCentre: 695, band: BAND, panelHeight: 60 }),
    ).toBe(670);
  });
});

describe("toPagePosition", () => {
  /**
   * The property the whole scroll behaviour rests on: a panel placed from a freshly-measured
   * `getBoundingClientRect` lands at the SAME page coordinate no matter where the document is
   * scrolled to. That is what lets the panel ride the diagram with no scroll listener — and it is why
   * the tooltip no longer has to be dismissed the moment the page moves.
   */
  it("is scroll-invariant: the same node maps to the same page position", () => {
    // The node's viewport y falls by exactly what the page scrolled by.
    const atRest = toPagePosition({ left: 120, top: 400 }, { x: 0, y: 0 });
    const scrolled = toPagePosition({ left: 120, top: 150 }, { x: 0, y: 250 });
    expect(scrolled).toEqual(atRest);
  });

  it("carries horizontal scroll too", () => {
    expect(toPagePosition({ left: 10, top: 20 }, { x: 5, y: 7 })).toEqual({
      left: 15,
      top: 27,
    });
  });
});
