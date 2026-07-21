"use client";

import { ttInterphases } from "@/lib/fonts/amber";
import type { SankeyLinkTooltip } from "./EnergyFlowSankey";

interface LinkTooltipProps {
  data: SankeyLinkTooltip;
  /** The link's SOURCE fill colour — the tooltip renders as a coloured "card" of the flow's origin,
   *  with dark text (mirrors the node box's own fill + black labels). */
  color: string;
  /** Viewport coords of the spline's midpoint — the card is centred on this point (translate ‑50%). */
  left: number;
  top: number;
  /** Hidden (but mounted) during a measure pass — unused today (centring needs no measurement), kept
   *  for parity with NodeTooltip's API. */
  hidden?: boolean;
}

/**
 * Presentational Sankey LINK tooltip — a small coloured card centred on the hovered spline. Line 1 is
 * the flow energy (kWh) or power (kW); line 2 (attributed windows only) is emissions · cost · renewable
 * in smaller text. Dark-on-colour, matching NodeTooltip. NO positioning logic here — the caller
 * (EnergyFlowSankey) computes the spline midpoint and passes it as `left`/`top`.
 */
export default function LinkTooltip({
  data,
  color,
  left,
  top,
  hidden = false,
}: LinkTooltipProps) {
  const hasDetail = data.emissions !== undefined;
  return (
    <div
      className={`link-tooltip ${ttInterphases.className} fixed z-[100] pointer-events-none rounded px-2.5 py-1.5 text-center shadow-lg`}
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
