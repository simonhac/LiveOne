/**
 * Where a Sankey node's tooltip panel sits HORIZONTALLY, and whether it ends up on top of the node
 * it describes.
 *
 * Pure arithmetic, extracted from `EnergyFlowSankey`'s placement effect so the cases that only occur
 * at particular viewport widths — a phone, a three-column battery-middle layout, a desktop window
 * narrowed past the point where a panel fits outside the diagram — can be asserted rather than
 * hunted for by hand. Following `lib/charts/svg`'s rule: a wrong number is a bug, so the numbers are
 * unit-tested; the DOM around them is not.
 *
 * Everything here is in VIEWPORT px except the `columns`/node `x0`/`x1`, which are SVG user units
 * (the caller converts with `svg.leftVp` + `svg.scaleX`) — matching the effect this came out of.
 * `toPagePosition` converts the result for rendering; see its comment for why that last step matters.
 */

export interface PanelHorizontalInput {
  /** Which side of the node the panel wants: its column's outward side. May be FLIPPED by the result. */
  side: "left" | "right";
  node: {
    /** Viewport-space edges of the node box. */
    leftVp: number;
    rightVp: number;
    /** SVG-space edges, for locating the node's column in `columns`. */
    x0: number;
    x1: number;
  };
  /** Every column's SVG x-range, left→right (`SankeyGeom.columns`). */
  columns: { x0: number; x1: number }[];
  svg: {
    /** Viewport x of the svg's left edge. */
    leftVp: number;
    /** SVG user px → CSS px. 1 today; kept as a scale guard. */
    scaleX: number;
    /** The svg's width in SVG user units. */
    width: number;
  };
  panelWidth: number;
  /** Clearance between the node and the panel. */
  gap: number;
  /** Clamp a candidate left edge into the viewport. Supplied by the caller, which owns `window`. */
  clampX: (left: number) => number;
}

export interface PanelHorizontal {
  /** The side the panel ACTUALLY ended up on — also which edge its beak points from. */
  side: "left" | "right";
  left: number;
  /**
   * The panel overlaps its own node horizontally, so it has nowhere honest to put a beak. The caller
   * turns this into `beakVariant: "none"`. After the inward placement below this is a last resort —
   * a viewport narrow enough that `clampX` pushes the panel back over the node — rather than, as it
   * once was, the normal outcome on a phone.
   */
  overlapsNode: boolean;
}

export function panelHorizontal(opts: PanelHorizontalInput): PanelHorizontal {
  const { node, columns, svg, panelWidth, gap, clampX } = opts;

  /** Hang the panel off `on`'s far edge, `gap` clear of the node. */
  const beside = (on: "left" | "right") =>
    clampX(on === "left" ? node.leftVp - gap - panelWidth : node.rightVp + gap);

  let side = opts.side;
  let left = beside(side);
  const fitsBeside =
    side === "left" ? left + panelWidth <= node.leftVp : left >= node.rightVp;

  if (!fitsBeside) {
    const i = columns.findIndex(
      (c) => Math.round(c.x0) === Math.round(node.x0),
    );
    const neighbour =
      i < 0 ? undefined : columns[side === "left" ? i - 1 : i + 1];
    if (i >= 0 && !neighbour) {
      // An OUTERMOST node with no room outside it — every left/right-column node on mobile, where
      // the diagram spans the viewport and the columns hug its edges. FLIP the panel to the node's
      // inner side and hang it off that edge, so it still points at its node and does NOT sit on it.
      //
      // 🛑 Not centred in the channel between the columns, which is what this did before. That only
      // clears the node when the channel is wider than the panel plus the node, and in the
      // battery-middle layout on a phone it is not: three 72px columns across ~393px leaves an ~88px
      // channel, so the centred panel landed ON its own node and the beak silently disappeared.
      side = side === "left" ? "right" : "left";
      left = beside(side);
    } else {
      // An INTERIOR node (the battery-middle centre column): it has a channel on `side`, so centre
      // the panel in it. Flipping here is not an option — the dual battery panels would swap, and the
      // left panel's content would be sitting on the right.
      const gapCentreSvg = !neighbour
        ? svg.width / 2
        : side === "left"
          ? (neighbour.x1 + node.x0) / 2
          : (node.x1 + neighbour.x0) / 2;
      left = clampX(svg.leftVp + gapCentreSvg * svg.scaleX - panelWidth / 2);
    }
  }

  return {
    side,
    left,
    overlapsNode: left < node.rightVp && left + panelWidth > node.leftVp,
  };
}

/**
 * Where a panel sits VERTICALLY: inside the rows it describes.
 *
 * Space-agnostic — viewport or page, as long as `desiredTop` and `band` agree. The caller works in
 * viewport px (that is what `getBoundingClientRect` hands it) and converts once at the end, via
 * `toPagePosition`.
 *
 * A panel taller than the band pins to its top and overflows the bottom.
 */
export function panelTop(opts: {
  /** Where the node's own vertical anchoring wants the panel's top edge. */
  desiredTop: number;
  /** The node band: the diagram's topmost and bottommost node edges. */
  band: { top: number; bottom: number };
  panelHeight: number;
}): number {
  const { desiredTop, band, panelHeight: h } = opts;
  return Math.max(band.top, Math.min(desiredTop, band.bottom - h));
}

/**
 * `panelTop` for a card positioned by its CENTRE rather than its top edge (the link tooltip, which
 * translates ‑50%). Same clamp, expressed in centres.
 */
export function panelCentreY(opts: {
  desiredCentre: number;
  band: { top: number; bottom: number };
  panelHeight: number;
}): number {
  const half = opts.panelHeight / 2;
  return (
    panelTop({
      desiredTop: opts.desiredCentre - half,
      band: opts.band,
      panelHeight: opts.panelHeight,
    }) + half
  );
}

/**
 * Viewport px → PAGE px, which is what the panels are actually positioned in.
 *
 * 🛑 This is the whole reason the panels survive a scroll, and it is worth stating plainly. They used
 * to be `position: fixed` at viewport coordinates, which meant the diagram scrolled and the panel did
 * not — it detached from its node and hung in mid-air. The workaround was to DISMISS the tooltip on
 * every scroll event, which is worse: you cannot read a panel and scroll the chart under it, and on
 * mobile the URL bar collapsing fires `resize`/`scroll` and closed it for you unprompted.
 *
 * Anchoring to the page instead makes the browser do it: `position: absolute` at a document
 * coordinate travels with the diagram for free, so there is no scroll listener, nothing to go stale,
 * and nothing to dismiss. The panel goes under the sticky header exactly as the chart does — which is
 * also why it must not out-rank the header in z-order.
 */
export function toPagePosition(
  pos: { left: number; top: number },
  scroll: { x: number; y: number },
): { left: number; top: number } {
  return { left: pos.left + scroll.x, top: pos.top + scroll.y };
}
