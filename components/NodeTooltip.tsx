"use client";

import { X } from "lucide-react";
import { ttInterphases } from "@/lib/fonts/amber";
import type { SankeyMetric, SankeyNodeTooltip } from "./EnergyFlowSankey";

interface NodeTooltipProps {
  data: SankeyNodeTooltip;
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
  /** Hide (but keep mounted, for measurement) during the first "measure" pass — avoids a flash at the
   *  wrong position before the real height is known. */
  hidden?: boolean;
  panelRef?: React.Ref<HTMLDivElement>;
  onClose?: () => void;
}

/** A labelled metric: primary value, optional "/ secondary" (e.g. "12.3 kWh / 2.1 kW"). */
function MetricStat({
  caption,
  metric,
  valueClassName,
}: {
  caption: string;
  metric: SankeyMetric;
  valueClassName?: string;
}) {
  return (
    <div>
      <p
        className={`whitespace-nowrap text-xl font-bold leading-none ${
          valueClassName ?? "text-gray-100"
        }`}
      >
        {metric.primary}
        {metric.secondary && (
          <span className="ml-1 text-xs font-normal text-gray-500">
            / {metric.secondary}
          </span>
        )}
      </p>
      <p className="mt-1 text-[10px] uppercase tracking-wide text-gray-500">
        {caption}
      </p>
    </div>
  );
}

/**
 * Presentational Sankey node tooltip — a side panel (with a beak pointing at the hovered node) or a
 * mobile/collision overlay. NO measurement or positioning logic here (the caller, `EnergyFlowSankey`,
 * computes `left`/`top`/`beakTop` from the node's screen geometry); this component only renders the
 * chrome + content at the given geometry. Chrome mirrors `SystemInfoTooltip.tsx`'s tooltip styling.
 */
export default function NodeTooltip({
  data,
  variant,
  side = "left",
  left = 0,
  top = 0,
  beakTop = 20,
  width = 220,
  hidden = false,
  panelRef,
  onClose,
}: NodeTooltipProps) {
  const isFull = data.variant === "full";
  // `renewable.primary` is `formatRenewablePct`'s output ("89%" | "—") — parse it back rather than
  // threading a second raw-number field through the tooltip payload contract.
  const renewablePct = isFull ? parseFloat(data.renewable.primary) : NaN;
  const renewableGreen = !Number.isNaN(renewablePct) && renewablePct > 50;

  return (
    <div
      ref={panelRef}
      className={`node-tooltip ${ttInterphases.className} rounded-lg border border-gray-700 bg-gray-900 p-3 shadow-lg ${
        variant === "side"
          ? "fixed z-[100] pointer-events-none"
          : "fixed inset-x-2 top-1/2 z-[100] mx-auto -translate-y-1/2 pointer-events-auto"
      }`}
      style={
        variant === "side"
          ? { left, top, width, visibility: hidden ? "hidden" : "visible" }
          : { maxWidth: 320 }
      }
    >
      {variant === "side" && (
        <div
          className={`absolute h-3 w-3 rotate-45 bg-gray-900 ${
            side === "left"
              ? "border-r border-t border-gray-700"
              : "border-b border-l border-gray-700"
          }`}
          style={{
            ...(side === "left" ? { right: -6 } : { left: -6 }),
            top: beakTop - 6,
          }}
        />
      )}

      {variant === "overlay" && onClose && (
        <button
          type="button"
          onClick={onClose}
          aria-label="Close"
          className="absolute right-2 top-2 text-gray-500 hover:text-gray-300"
        >
          <X size={16} />
        </button>
      )}

      <p className="mb-2 pr-4 text-sm font-semibold text-gray-200">
        {data.name}
      </p>

      {isFull ? (
        <div className="grid grid-cols-2 gap-x-4 gap-y-3">
          <MetricStat caption="energy" metric={data.energy} />
          <MetricStat caption="emissions" metric={data.emissions} />
          <MetricStat caption="cost" metric={data.cost} />
          <MetricStat
            caption="renewable"
            metric={data.renewable}
            valueClassName={renewableGreen ? "text-green-400" : undefined}
          />
        </div>
      ) : (
        <MetricStat caption="power" metric={data.energy} />
      )}

      {isFull && !!data.estimatedPct && data.estimatedPct > 0 && (
        <div className="mt-3 flex justify-end">
          <span className="rounded-full border border-amber-500/40 bg-amber-500/10 px-2 py-0.5 text-[11px] text-amber-300">
            {Math.round(data.estimatedPct)}% estimated
          </span>
        </div>
      )}
    </div>
  );
}
