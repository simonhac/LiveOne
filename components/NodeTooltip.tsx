"use client";

import { X } from "lucide-react";
import { ttInterphases } from "@/lib/fonts/amber";
import type {
  SankeyMetric,
  SankeyMetricValue,
  SankeyNodeTooltip,
} from "./EnergyFlowSankey";

interface NodeTooltipProps {
  data: SankeyNodeTooltip;
  /** The hovered node's fill colour. The tooltip renders as a coloured "card" of the node it
   *  describes — this colour is the panel (and beak) background, with dark text, mirroring the
   *  node box's own fill + black labels. */
  nodeColor: string;
  /** "side" = beaked panel anchored beside a node (desktop); "overlay" = centered panel with a close
   *  button (mobile tap, or a desktop side-panel that would collide with the diagram). */
  variant: "side" | "overlay";
  /** Which side of the node the panel sits on ("side" variant only) — also which edge the beak points
   *  from (opposite the node). */
  side?: "left" | "right";
  left?: number;
  top?: number;
  /** Beak offset from the panel's top edge, clamped to point at the node even when the panel is
   *  vertically clamped to the column band. */
  beakTop?: number;
  width?: number;
  /** Show the node-type heading chip at the top. Omitted (false) when the node box itself is tall
   *  enough to already render its own title — no point repeating it. */
  showHeading?: boolean;
  /** Beak shape. "diamond" = the square-on-point centred at `beakTop` (tall nodes). For a node too
   *  short for the diamond, a "half beak" — a triangle with a flat horizontal edge (running toward the
   *  node) and a 45° return to the panel — sitting on the node's near edge: "half-bottom" flat edge at
   *  the node's BOTTOM (bottom/middle nodes, tapers up), "half-top" flat edge at its TOP (top nodes,
   *  tapers down). For a half beak, `beakTop` is the y of that flat edge (not the diamond's centre). */
  beakVariant?: "diamond" | "half-top" | "half-bottom";
  /** Hide (but keep mounted, for measurement) during the first "measure" pass — avoids a flash at the
   *  wrong position before the real height is known. */
  hidden?: boolean;
  panelRef?: React.Ref<HTMLDivElement>;
  onClose?: () => void;
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

/** A labelled metric: the category caption on top, then the absolute + optional rate as two columns
 *  (no "/" separator). Dark-on-colour (sits on the node's fill). */
function MetricStat({
  caption,
  metric,
}: {
  caption: string;
  metric: SankeyMetric;
}) {
  return (
    <div>
      <p className="mb-0.5 text-[10px] font-medium uppercase tracking-wide text-black/55">
        {caption}
      </p>
      <div className="grid grid-cols-2 gap-x-2">
        <MetricColumn v={metric.primary} />
        {metric.secondary && <MetricColumn v={metric.secondary} muted />}
      </div>
    </div>
  );
}

/**
 * Presentational Sankey node tooltip — a side panel (with a beak pointing at the hovered node) or a
 * mobile/collision overlay, rendered as a coloured "card" of the node it describes: the node's fill
 * colour as background, 4px corners, dark text (mirrors the node box's own labels). The node type sits
 * at the top (the sankey node's own label is not always visible on smaller diagrams), and each metric
 * mirrors the node layout — category caption, big value, unit beneath. NO measurement or positioning
 * logic here (the caller, `EnergyFlowSankey`, computes `left`/`top`/`beakTop`); this component only
 * renders the chrome + content at the given geometry.
 */
export default function NodeTooltip({
  data,
  nodeColor,
  variant,
  side = "left",
  left = 0,
  top = 0,
  beakTop = 20,
  width = 160,
  showHeading = true,
  beakVariant = "diamond",
  hidden = false,
  panelRef,
  onClose,
}: NodeTooltipProps) {
  const isFull = data.variant === "full";

  // With a half beak, the panel corner nearest the beak must be square — a rounded corner there leaves
  // a dark notch between the beak's hypotenuse and the panel edge. The beak sits on the side opposite
  // the node (right edge for a left-anchored panel, left edge for a right-anchored one) and at the
  // node's near edge (bottom for "half-bottom", top for "half-top").
  const squaredCorner: string | null =
    beakVariant === "diamond"
      ? null
      : beakVariant === "half-bottom"
        ? side === "left"
          ? "borderBottomRightRadius"
          : "borderBottomLeftRadius"
        : side === "left"
          ? "borderTopRightRadius"
          : "borderTopLeftRadius";

  return (
    <div
      ref={panelRef}
      className={`node-tooltip ${ttInterphases.className} rounded p-3 shadow-lg ${
        variant === "side"
          ? "fixed z-[100] pointer-events-none"
          : "fixed inset-x-2 top-1/2 z-[100] mx-auto -translate-y-1/2 pointer-events-auto"
      }`}
      style={
        variant === "side"
          ? {
              left,
              top,
              width,
              backgroundColor: nodeColor,
              visibility: hidden ? "hidden" : "visible",
              ...(squaredCorner ? { [squaredCorner]: 0 } : {}),
            }
          : { maxWidth: 260, backgroundColor: nodeColor }
      }
    >
      {variant === "side" &&
        (beakVariant === "diamond" ? (
          <div
            className="absolute h-3 w-3 rotate-45"
            style={{
              ...(side === "left" ? { right: -6 } : { left: -6 }),
              top: beakTop - 6,
              backgroundColor: nodeColor,
            }}
          />
        ) : (
          // Short node: a "half beak" — a 7px triangle with a flat horizontal edge running toward the
          // node, then a 45° hypotenuse back to the panel (half a beak, vertically). It hugs the node's
          // near edge: "half-bottom" flat edge sits on `beakTop` (the node's bottom) and tapers up;
          // "half-top" flat edge sits on `beakTop` (the node's top) and tapers down.
          <div
            className="absolute"
            style={{
              width: 7,
              height: 7,
              // half-bottom: flat edge is the container's BOTTOM (→ sits at beakTop); half-top: flat
              // edge is the container's TOP (→ sits at beakTop).
              top: beakVariant === "half-bottom" ? beakTop - 7 : beakTop,
              ...(side === "left"
                ? {
                    right: -7,
                    clipPath:
                      beakVariant === "half-bottom"
                        ? "polygon(0 100%, 100% 100%, 0 0)"
                        : "polygon(0 0, 100% 0, 0 100%)",
                  }
                : {
                    left: -7,
                    clipPath:
                      beakVariant === "half-bottom"
                        ? "polygon(100% 100%, 0 100%, 100% 0)"
                        : "polygon(100% 0, 0 0, 100% 100%)",
                  }),
              backgroundColor: nodeColor,
            }}
          />
        ))}

      {variant === "overlay" && onClose && (
        <button
          type="button"
          onClick={onClose}
          aria-label="Close"
          className="absolute right-2 top-2 text-black/50 hover:text-black/80"
        >
          <X size={16} />
        </button>
      )}

      {/* Hard backstop against spill — sits inside the panel's padding so it never clips the beak,
          which is anchored outside the panel bounds. */}
      <div className={`overflow-hidden ${variant === "overlay" ? "pr-6" : ""}`}>
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

        {isFull ? (
          <div className="flex flex-col gap-2.5">
            <MetricStat caption="energy" metric={data.energy} />
            <MetricStat caption="emissions" metric={data.emissions} />
            <MetricStat caption="cost" metric={data.cost} />
            <MetricStat caption="renewable" metric={data.renewable} />
          </div>
        ) : (
          <MetricStat caption="power" metric={data.energy} />
        )}

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
