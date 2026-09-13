"use client";

import { ttInterphases } from "@/lib/fonts/amber";
import type { SankeyLinkTooltip } from "./EnergyFlowSankey";

interface LinkTooltipProps {
  data: SankeyLinkTooltip;
  /** The link's SOURCE fill colour — the tooltip renders as a coloured "card" of the flow's origin,
   *  with dark text (mirrors the node box's own fill + black labels). */
  color: string;
  /** PAGE coords the card is centred on (translate ‑50%): the spline's midpoint, with `top` pulled
   *  back by the caller so the card stays inside the diagram's vertical band. Page, not viewport, so
   *  the card rides the document when it scrolls — see `toPagePosition`. */
  left: number;
  top: number;
  /** Hidden (but mounted) during the measure pass — the vertical clamp needs the card's real height, so
   *  the first frame renders at the raw midpoint, invisible (mirrors NodeTooltip). */
  hidden?: boolean;
  panelRef?: React.Ref<HTMLDivElement>;
  /** Tap-to-dismiss, and the switch that lets the card receive the tap at all — see the same prop on
   *  `NodeTooltip` for why a hover-held card must stay `pointer-events-none`. */
  onDismiss?: () => void;
}

/**
 * Presentational Sankey LINK tooltip — a small coloured card centred on the hovered spline. Line 1 is
 * the flow energy (kWh) or power (kW); line 2 (attributed windows only) is emissions · cost · renewable
 * in smaller text. Dark-on-colour, matching NodeTooltip. NO positioning logic here — the caller
 * (EnergyFlowSankey) computes the spline midpoint, clamps it to the node band, and passes the result as
 * `left`/`top`.
 */
export default function LinkTooltip({
  data,
  color,
  left,
  top,
  hidden = false,
  panelRef,
  onDismiss,
}: LinkTooltipProps) {
  const hasDetail = data.emissions !== undefined;
  return (
    <div
      ref={panelRef}
      // `absolute` + `z-20`: page-anchored so it scrolls with the diagram, and below the sticky
      // header's `z-30` so it passes under it. Same reasoning as `NodeTooltip`.
      className={`link-tooltip ${ttInterphases.className} absolute z-20 ${
        onDismiss ? "pointer-events-auto" : "pointer-events-none"
      } rounded px-2.5 py-1.5 text-center shadow-lg`}
      onClick={onDismiss}
      style={{
        left,
        top,
        transform: "translate(-50%, -50%)",
        backgroundColor: color,
        visibility: hidden ? "hidden" : "visible",
      }}
    >
      <p className="text-sm font-bold leading-tight text-black">
        {data.energy}
        <span className="ml-1 text-[10px] font-medium text-black/60">
          {data.energyUnit}
        </span>
      </p>
      {hasDetail && (
        <p className="mt-0.5 text-[10px] leading-tight text-black/60">
          {data.emissions} · {data.cost} · {data.renewable}
        </p>
      )}
    </div>
  );
}
