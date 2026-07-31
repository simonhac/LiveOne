"use client";

import { ttInterphases } from "@/lib/fonts/amber";
import type {
  SankeyMetric,
  SankeyMetricValue,
  SankeyNodeTooltip,
} from "./EnergyFlowSankey";

/**
 * Panel width (px) — the single source of truth, also read by `EnergyFlowSankey`'s placement maths (it
 * anchors a left-side panel by its RIGHT edge, so it needs the width before the panel is measurable).
 * 140 leaves 108px of content, which the two value columns divide by need (see MetricStat): enough for
 * a month's worth of digits at 18px bold — "$456.27" beside "18.4", "1803.4" beside "727". A number
 * past that wraps rather than overflowing, which is the right trade at a year's scale.
 */
export const PANEL_WIDTH = 140;

/**
 * Beak geometry — declared HERE, beside the markup that renders it, and (where the maths needs them)
 * exported to `EnergyFlowSankey`, which decides where — and whether — a beak fits. One home, so the
 * two can't drift.
 */
/** Diamond beak: an unrotated square this many px on a side, rendered `rotate-45`. */
const BEAK_SIZE = 12;
/** …which means it stands BEAK_SIZE·√2 ≈ 17px TALL. The SPAN, not the side, is what has to fit on a
 *  node — a node shorter than this has no room for the whole diamond. */
export const BEAK_SPAN = Math.round(BEAK_SIZE * Math.SQRT2);
/** Half the span — keeps the WHOLE diamond inside a range, not just its centre. */
export const BEAK_HALF_SPAN = Math.round(BEAK_SPAN / 2);
/** Half beak: a right triangle this many px on each leg. */
export const HALF_BEAK_SIZE = 7;
/** Keep the diamond's CENTRE this far in from the panel's top/bottom edge, so it never collides with
 *  a rounded corner. This is the panel's own `p-3` padding — equal to BEAK_SIZE only by coincidence,
 *  don't merge them. */
export const BEAK_CORNER_INSET = 12;

/**
 * A half beak always sits in one panel CORNER: the beak's side (opposite the node) × the node's near
 * edge. Both the squared corner — a rounded one leaves a dark notch between the beak's hypotenuse and
 * the panel edge — and the triangle's clip-path follow from that single fact, so both are read from
 * this one table rather than re-derived from `side`/`beakVariant` separately.
 *
 * The clip-path is the triangle's flat edge (running toward the node) plus the 45° hypotenuse back to
 * the panel: e.g. "bottom-right" keeps the bottom edge and the box's top-LEFT corner, so it tapers up
 * and away from the node.
 */
const HALF_BEAK_CORNER = {
  "top-right": {
    radius: "borderTopRightRadius",
    clip: "polygon(0 0, 100% 0, 0 100%)",
  },
  "top-left": {
    radius: "borderTopLeftRadius",
    clip: "polygon(100% 0, 0 0, 100% 100%)",
  },
  "bottom-right": {
    radius: "borderBottomRightRadius",
    clip: "polygon(0 100%, 100% 100%, 0 0)",
  },
  "bottom-left": {
    radius: "borderBottomLeftRadius",
    clip: "polygon(100% 100%, 0 100%, 100% 0)",
  },
} as const;

interface NodeTooltipProps {
  data: SankeyNodeTooltip;
  /** The hovered node's fill colour. The tooltip renders as a coloured "card" of the node it
   *  describes — this colour is the panel (and beak) background, with dark text, mirroring the
   *  node box's own fill + black labels. */
  nodeColor: string;
  /** Which side of the node the panel sits on — also which edge the beak points from (opposite the
   *  node). Beside the node on desktop; in the gap between the columns on mobile (or when the
   *  beside-the-node panel wouldn't fit), where it still faces the node's column. */
  side?: "left" | "right";
  left?: number;
  top?: number;
  /** Beak offset from the panel's top edge — the panel's own vertical centre where that still lands on
   *  the node, else pulled back onto the node (see EnergyFlowSankey's `compute`). */
  beakTop?: number;
  width?: number;
  /** Show the node-type heading chip at the top. Omitted (false) when the node box itself is tall
   *  enough to already render its own title — no point repeating it. */
  showHeading?: boolean;
  /** Beak shape. "diamond" = the square-on-point centred at `beakTop` — the default, including for a
   *  thin node mid-column (the panel extends past it both ways, so the whole diamond still lands on
   *  the panel). The "half beak" — a triangle with a flat horizontal edge (running toward the node)
   *  and a 45° return to the panel — is for a thin node at a column EXTREME, where the panel is edge-
   *  aligned to the node and a diamond would hang off its end: "half-top" flat edge at the node's TOP
   *  (topmost node, tapers down), "half-bottom" flat edge at its BOTTOM (bottommost node, tapers up).
   *  For a half beak, `beakTop` is the y of that flat edge (not the diamond's centre).
   *  "none" = no beak at all, for a panel that overlaps its own node (a narrow phone, or the interior
   *  battery node) — a beak pointing at a node the card sits on top of reads as a glitch. */
  beakVariant?: "diamond" | "half-top" | "half-bottom" | "none";
  /** Hide (but keep mounted, for measurement) during the first "measure" pass — avoids a flash at the
   *  wrong position before the real height is known. */
  hidden?: boolean;
  panelRef?: React.Ref<HTMLDivElement>;
}

/** One value column — a bold number with its unit rendered beneath (mirrors the Sankey node's "58.4"
 *  over "kWh"). `muted` dims the secondary (rate) column so it reads as subordinate to the absolute,
 *  without shrinking it. */
function MetricColumn({
  v,
  muted = false,
}: {
  v: SankeyMetricValue;
  muted?: boolean;
}) {
  return (
    <div className="min-w-0">
      <p
        className={`text-lg font-bold leading-none break-words ${
          muted ? "text-black/55" : "text-black"
        }`}
      >
        {v.value}
      </p>
      {v.unit && (
        <p className="mt-0.5 text-[10px] leading-none text-black/55">
          {v.unit}
        </p>
      )}
    </div>
  );
}

/**
 * A labelled metric, as TWO rows of the card's SHARED grid: the category caption (spanning both
 * columns), then the absolute + optional rate side by side (no "/" separator). Dark-on-colour (sits on
 * the node's fill).
 *
 * All four metrics live in ONE grid rather than a grid each — that's what keeps the rate column aligned
 * straight down the card while still letting the two columns size themselves to the content. An even
 * 50/50 split would waste the card's width: the absolute needs the room ("$211.27", "767.8") and the
 * rate rarely does ("15.4", "560").
 */
function MetricStat({
  caption,
  metric,
  first = false,
}: {
  caption: string;
  metric: SankeyMetric;
  /** The card's first metric sits flush under the heading; the rest open a gap above the caption. */
  first?: boolean;
}) {
  return (
    <>
      <p
        className={`col-span-2 mb-0.5 text-[10px] font-medium uppercase tracking-wide text-black/55 ${
          first ? "" : "mt-2"
        }`}
      >
        {caption}
      </p>
      <MetricColumn v={metric.primary} />
      {metric.secondary && <MetricColumn v={metric.secondary} muted />}
    </>
  );
}

/**
 * Presentational Sankey node tooltip — a beaked panel pointing at the hovered/tapped node, rendered as a
 * coloured "card" of the node it describes: the node's fill colour as background, 4px corners, dark text
 * (mirrors the node box's own labels). The node type sits at the top (the sankey node's own label is not
 * always visible on smaller diagrams), and each metric mirrors the node layout — category caption, big
 * value, unit beneath. NO measurement or positioning logic here (the caller, `EnergyFlowSankey`, computes
 * `left`/`top`/`beakTop`); this component only renders the chrome + content at the given geometry.
 */
export default function NodeTooltip({
  data,
  nodeColor,
  side = "left",
  left = 0,
  top = 0,
  beakTop = 20,
  width = PANEL_WIDTH,
  showHeading = true,
  beakVariant = "diamond",
  hidden = false,
  panelRef,
}: NodeTooltipProps) {
  const isFull = data.variant === "full";

  // Which panel corner a half beak sits in: the beak's side (opposite the node — the right edge for a
  // left-anchored panel, the left edge for a right-anchored one) × the node's near edge ("half-top" at
  // the node's TOP, "half-bottom" at its BOTTOM). Null for "diamond"/"none", which need neither the
  // squared corner nor a clip-path.
  const halfBeak =
    beakVariant === "half-top" || beakVariant === "half-bottom"
      ? HALF_BEAK_CORNER[
          `${beakVariant === "half-top" ? "top" : "bottom"}-${
            side === "left" ? "right" : "left"
          }`
        ]
      : null;

  return (
    <div
      ref={panelRef}
      className={`node-tooltip ${ttInterphases.className} fixed z-[100] pointer-events-none rounded p-3 shadow-lg`}
      style={{
        left,
        top,
        width,
        backgroundColor: nodeColor,
        visibility: hidden ? "hidden" : "visible",
        // A rounded corner under a half beak leaves a dark notch between the hypotenuse and the panel
        // edge, so that one corner goes square.
        ...(halfBeak ? { [halfBeak.radius]: 0 } : {}),
      }}
    >
      {beakVariant !== "none" &&
        // `halfBeak` non-null ⇒ a half beak; with "none" already excluded, the alternative is the
        // diamond.
        (halfBeak ? (
          // Thin node at a column extreme: a "half beak" — a HALF_BEAK_SIZE triangle with a flat
          // horizontal edge running toward the node, then a 45° hypotenuse back to the panel (half a
          // beak, vertically). It hugs the node's near edge: "half-bottom" flat edge sits on `beakTop`
          // (the node's bottom) and tapers up; "half-top" flat edge sits on `beakTop` (the node's top)
          // and tapers down.
          <div
            className="absolute"
            style={{
              width: HALF_BEAK_SIZE,
              height: HALF_BEAK_SIZE,
              // half-bottom: flat edge is the container's BOTTOM (→ sits at beakTop); half-top: flat
              // edge is the container's TOP (→ sits at beakTop).
              top:
                beakVariant === "half-bottom"
                  ? beakTop - HALF_BEAK_SIZE
                  : beakTop,
              ...(side === "left"
                ? { right: -HALF_BEAK_SIZE }
                : { left: -HALF_BEAK_SIZE }),
              clipPath: halfBeak.clip,
              backgroundColor: nodeColor,
            }}
          />
        ) : (
          // The diamond: a BEAK_SIZE square on point, centred on `beakTop`, half of it poking out past
          // the panel edge.
          <div
            className="absolute rotate-45"
            style={{
              width: BEAK_SIZE,
              height: BEAK_SIZE,
              ...(side === "left"
                ? { right: -BEAK_SIZE / 2 }
                : { left: -BEAK_SIZE / 2 }),
              top: beakTop - BEAK_SIZE / 2,
              backgroundColor: nodeColor,
            }}
          />
        ))}

      {/* Hard backstop against spill — sits inside the panel's padding so it never clips the beak,
          which is anchored outside the panel bounds. */}
      <div className="overflow-hidden">
        {/* Node type at the top — only when the node box itself is too short to show its own title.
            Placed like the node's label: centred, a fixed distance from the top (the card's padding).
            Mirrors the node box's translucent-white label chip. */}
        {showHeading && (
          <div className="mb-2 flex justify-center">
            <span className="rounded bg-white/25 px-2 py-0.5 text-[11px] font-medium uppercase tracking-wide text-black">
              {data.name}
            </span>
          </div>
        )}

        {/* `auto` first column: the absolute takes the width it needs and the rate column keeps the
            remainder (see MetricStat). */}
        <div className="grid grid-cols-[auto_1fr] gap-x-2">
          {isFull ? (
            <>
              <MetricStat caption="energy" metric={data.energy} first />
              <MetricStat caption="emissions" metric={data.emissions} />
              <MetricStat caption="cost" metric={data.cost} />
              <MetricStat caption="renewable" metric={data.renewable} />
            </>
          ) : (
            <MetricStat caption="power" metric={data.energy} first />
          )}
        </div>

        {isFull && !!data.estimatedPct && data.estimatedPct > 0 && (
          <div className="mt-3 flex justify-end">
            <span className="rounded-full border border-black/15 bg-black/10 px-2 py-0.5 text-[11px] text-black/70">
              {Math.round(data.estimatedPct)}% estimated
            </span>
          </div>
        )}
      </div>
    </div>
  );
}
